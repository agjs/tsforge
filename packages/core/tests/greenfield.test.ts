import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runGreenfield,
  loadState,
  saveState,
  renderProgress,
  greenfieldDir,
} from "../src/loop/greenfield";
import type {
  IGreenfieldState,
  IGreenfieldDeps,
  IFeature,
} from "../src/loop/greenfield";
import type { IHandoff } from "../src/loop/loop.types";

function feature(id: string, passes = false): IFeature {
  return { id, desc: `do ${id}`, passes, attempts: 0 };
}

function state(...ids: string[]): IGreenfieldState {
  return { goal: "build a thing", features: ids.map((id) => feature(id)) };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tsforge-gf-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("greenfield state", () => {
  test("saveState → loadState round-trips the checklist", async () => {
    const s = state("a", "b");

    s.features[1]!.passes = true;
    s.features[1]!.attempts = 2;
    await saveState(dir, s);

    const loaded = await loadState(dir);

    expect(loaded?.goal).toBe("build a thing");
    expect(loaded?.features.map((f) => f.id)).toEqual(["a", "b"]);
    expect(loaded?.features[1]?.passes).toBe(true);
    expect(loaded?.features[1]?.attempts).toBe(2);
  });

  test("loadState returns null when no state exists or it's corrupt", async () => {
    expect(await loadState(dir)).toBeNull();

    await mkdir(greenfieldDir(dir), { recursive: true });
    await writeFile(join(greenfieldDir(dir), "features.json"), "{not json");
    expect(await loadState(dir)).toBeNull();
  });

  test("loadState drops malformed feature entries without crashing", async () => {
    await mkdir(greenfieldDir(dir), { recursive: true });
    await writeFile(
      join(greenfieldDir(dir), "features.json"),
      JSON.stringify({
        goal: "g",
        features: [{ id: "ok", desc: "fine" }, { desc: "no id" }, 42],
      })
    );

    const loaded = await loadState(dir);

    expect(loaded?.features.map((f) => f.id)).toEqual(["ok"]);
    expect(loaded?.features[0]?.passes).toBe(false); // defaulted
  });

  test("renderProgress shows a tick per verified feature + a count", () => {
    const s = state("a", "b");

    s.features[0]!.passes = true;

    const md = renderProgress(s);

    expect(md).toContain("1/2 features verified");
    expect(md).toContain("- [x] a");
    expect(md).toContain("- [ ] b");
  });

  test("saveState → loadState round-trips lastError when present", async () => {
    const s = state("a");

    s.features[0]!.lastError =
      "Gate errors: TS2322 type mismatch in src/index.ts:15";
    await saveState(dir, s);

    const loaded = await loadState(dir);

    expect(loaded?.features[0]?.lastError).toBe(
      "Gate errors: TS2322 type mismatch in src/index.ts:15"
    );
  });

  test("loadState defaults to undefined when lastError is absent", async () => {
    const s = state("a");

    await saveState(dir, s);

    const loaded = await loadState(dir);

    expect(loaded?.features[0]?.lastError).toBeUndefined();
  });
});

describe("runGreenfield: outer loop", () => {
  test("implement returns done → feature ticks passing", async () => {
    const s = state("a");
    const deps: IGreenfieldDeps = {
      implement: async () => ({ done: true }),
    };
    const result = await runGreenfield(dir, s, deps);

    expect(result.status).toBe("done");
    expect(s.features[0]?.passes).toBe(true);
  });

  test("implement returns handoff → feature parks, then revisit", async () => {
    const s = state("a");
    let calls = 0;
    const handoff: IHandoff = {
      block: "a",
      rungHistory: [],
      errors: ["stuck"],
      ask: "help",
      resumable: true,
      resume: { triedLevers: [] },
    };
    const deps: IGreenfieldDeps = {
      implement: async () => {
        calls += 1;

        return calls === 1 ? { done: false, handoff } : { done: true };
      },
    };
    const result = await runGreenfield(dir, s, deps);

    expect(calls).toBe(2); // main pass parks, revisit pass retries seeded
    expect(result.status).toBe("done");
  });

  test("multiple features drive to green in order, ticking the checklist", async () => {
    const s = state("a", "b", "c");
    const implemented: string[] = [];
    const deps: IGreenfieldDeps = {
      implement: async (f) => {
        implemented.push(f.id);

        return { done: true };
      },
    };

    const res = await runGreenfield(dir, s, deps);

    expect(res.status).toBe("done");
    expect(implemented).toEqual(["a", "b", "c"]);
    expect(res.features.every((f) => f.passes)).toBe(true);

    // features.json on disk reflects the all-green end state
    const onDisk = await loadState(dir);

    expect(onDisk?.features.every((f) => f.passes)).toBe(true);
  });

  test("a parked feature gets revisited with seeded tried-levers", async () => {
    const s = state("a");
    const seedsReceived: {
      id: string;
      seed?: { triedLevers: string[] };
    }[] = [];

    const deps: IGreenfieldDeps = {
      implement: async (f, _, seed) => {
        seedsReceived.push({ id: f.id, seed });

        if (f.attempts === 1) {
          return {
            done: false,
            handoff: {
              block: "test",
              rungHistory: ["R1", "R2"],
              errors: ["error"],
              ask: "help",
              resumable: true,
              resume: { triedLevers: ["R1", "R2"] },
            },
          };
        }

        // Second attempt (revisit) should receive the seed
        return { done: true };
      },
    };

    const res = await runGreenfield(dir, s, deps);

    expect(res.status).toBe("done");
    expect(seedsReceived[1]?.seed?.triedLevers).toEqual(["R1", "R2"]);
  });

  test("resumes from persisted state (already-passing features are skipped)", async () => {
    const s = state("a", "b");

    s.features[0]!.passes = true; // 'a' already done
    const implemented: string[] = [];
    const deps: IGreenfieldDeps = {
      implement: async (f) => {
        implemented.push(f.id);

        return { done: true };
      },
    };

    await runGreenfield(dir, s, deps);

    expect(implemented).toEqual(["b"]); // 'a' skipped
  });

  test("persists the bumped attempt count even when implement throws", async () => {
    const s = state("a");
    const deps: IGreenfieldDeps = {
      implement: async () => {
        throw new Error("model died mid-attempt");
      },
    };

    // The throw propagates (crash), but the incremented counter must be on disk
    // so a resume doesn't replay attempt 0 forever.
    await expect(runGreenfield(dir, s, deps)).rejects.toThrow(
      "model died mid-attempt"
    );

    const onDisk = await loadState(dir);

    expect(onDisk?.features[0]?.attempts).toBe(1);
    expect(onDisk?.features[0]?.passes).toBe(false);
  });

  test("a repeatedly-crashing feature persists attempt count across resumes", async () => {
    const deps: IGreenfieldDeps = {
      implement: async () => {
        throw new Error("boom");
      },
    };

    // First run: implement throws, attempt is bumped and persisted
    const s = state("a");

    await expect(runGreenfield(dir, s, deps)).rejects.toThrow("boom");

    const onDisk = await loadState(dir);

    expect(onDisk?.features[0]?.attempts).toBe(1);
  });

  test("writes progress.md as it goes", async () => {
    const s = state("a");
    const deps: IGreenfieldDeps = {
      implement: async () => ({ done: true }),
    };

    await runGreenfield(dir, s, deps);

    const md = await readFile(join(greenfieldDir(dir), "progress.md"), "utf8");

    expect(md).toContain("1/1 features verified");
  });

  test("when implement returns done:false with handoff, the feature is parked and later features build", async () => {
    const s = state("a", "b");
    const implemented: string[] = [];
    const deps: IGreenfieldDeps = {
      implement: async (f) => {
        implemented.push(f.id);

        if (f.id === "a") {
          return {
            done: false,
            handoff: {
              block: "test-block",
              rungHistory: ["R1", "R2", "R3", "R4"],
              errors: ["some error"],
              ask: "needs help",
              resumable: true,
              resume: { triedLevers: ["R1", "R2", "R3", "R4"] },
            },
          };
        }

        return { done: true };
      },
    };

    const res = await runGreenfield(dir, s, deps);

    // 'a' is parked in main pass, then revisited once, returning handoff again
    expect(res.status).toBe("stuck");
    expect(res.stuckFeature).toBe("a");
    expect(implemented).toEqual(["a", "b", "a"]); // 'a' in main pass, 'b' in main pass, 'a' in revisit pass
    expect(s.features[0]?.parked).toBe(true);
    expect(s.features[0]?.handoff).toBeDefined();
    expect(s.features[1]?.passes).toBe(true); // 'b' completed normally
  });

  test("when a parked feature still fails after revisit, build reports fully-stuck", async () => {
    const s = state("a");
    const deps: IGreenfieldDeps = {
      implement: async () => ({
        done: false,
        handoff: {
          block: "test-block",
          rungHistory: ["R1", "R2", "R3", "R4"],
          errors: ["persistent error"],
          ask: "help",
          resumable: true,
          resume: { triedLevers: ["R1", "R2", "R3", "R4"] },
        },
      }),
    };

    const res = await runGreenfield(dir, s, deps);

    expect(res.status).toBe("stuck");
    expect(res.stuckFeature).toBe("a");
    expect(s.features[0]?.parked).toBe(true); // still parked after revisit
  });

  test("the park message carries implement's reason, not a hardcoded 'ladder exhausted'", async () => {
    // Guards the ONLY place reason becomes user-facing (run.ts `parked (${why})`). A
    // regression that dropped result.reason would silently reintroduce the build52 mislabel
    // (fast gate green, e2e failed, but logged as ladder exhaustion) — the verifyAcceptance
    // unit tests would still pass, so this end-to-end assertion is the real guard.
    const s = state("a");
    const messages: string[] = [];
    const deps: IGreenfieldDeps = {
      implement: async () => ({
        done: false,
        reason:
          "fast gate green but e2e acceptance still failing after the fix steer: row not found",
      }),
    };

    await runGreenfield(dir, s, deps, {
      onEvent: (ev) => {
        if (typeof ev.message === "string") {
          messages.push(ev.message);
        }
      },
    });

    const parkMsgs = messages.filter((m) => m.includes("parked"));

    expect(parkMsgs.length).toBeGreaterThan(0);
    expect(
      parkMsgs.some((m) => m.includes("e2e acceptance still failing"))
    ).toBe(true);
    // The reason was supplied, so the hardcoded-fallback phrase must NOT appear.
    expect(parkMsgs.every((m) => !m.includes("ladder exhausted"))).toBe(true);
  });

  test("a done:false with NO reason parks as 'no reason reported', never a fabricated cause", async () => {
    // Guards the neutral fallback: if a future impl returns done:false without a reason, the
    // log must surface the gap honestly, NOT re-introduce a plausible-but-wrong "ladder
    // exhausted" that this whole change exists to eliminate.
    const s = state("a");
    const messages: string[] = [];
    const deps: IGreenfieldDeps = {
      implement: async () => ({ done: false }),
    };

    await runGreenfield(dir, s, deps, {
      onEvent: (ev) => {
        if (typeof ev.message === "string") {
          messages.push(ev.message);
        }
      },
    });

    const parkMsgs = messages.filter((m) => m.includes("parked"));

    expect(parkMsgs.length).toBeGreaterThan(0);
    expect(parkMsgs.some((m) => m.includes("no reason reported"))).toBe(true);
    expect(parkMsgs.every((m) => !m.includes("ladder exhausted"))).toBe(true);
  });

  test("a park persists its handoff errors as lastError (revisit isn't blind)", async () => {
    // Regression guard: lastError was NEVER set on a park, so refinePrompt's "PREVIOUS attempt
    // FAILED — FIX THESE ERRORS" block never fired on a revisit and the model rebuilt blind.
    const s = state("a");
    const deps: IGreenfieldDeps = {
      implement: async () => ({
        done: false,
        handoff: {
          block: "b",
          rungHistory: [],
          errors: [
            "src/x.test.ts:1  require-await",
            "src/y.ts:2  no-unused-vars",
          ],
          ask: "help",
          resumable: true,
          resume: { triedLevers: [] },
        },
      }),
    };

    await runGreenfield(dir, s, deps);

    const onDisk = await loadState(dir);
    const parked = onDisk?.features.find((f) => f.id === "a");

    expect(parked?.lastError).toContain("require-await");
    expect(parked?.lastError).toContain("no-unused-vars");
  });

  test("the revisit's implement RECEIVES the parked feature's lastError", async () => {
    // The round-trip that matters: attempt 1 parks with errors → the revisit (attempt 2) sees
    // them on `feature.lastError` so refinePrompt can lead with the specific failures.
    const s = state("a");
    const seenLastErrors: (string | undefined)[] = [];
    let call = 0;
    const deps: IGreenfieldDeps = {
      implement: async (f) => {
        seenLastErrors.push(f.lastError);
        call += 1;

        if (call === 1) {
          return {
            done: false,
            handoff: {
              block: "b",
              rungHistory: [],
              errors: ["ERR_LINE_MARKER"],
              ask: "help",
              resumable: true,
              resume: { triedLevers: [] },
            },
          };
        }

        return { done: true };
      },
    };

    await runGreenfield(dir, s, deps);

    expect(seenLastErrors[0]).toBeUndefined();
    expect(seenLastErrors[1]).toContain("ERR_LINE_MARKER");
  });

  test("a park with NO handoff falls back to the reason as lastError", async () => {
    const s = state("a");
    const deps: IGreenfieldDeps = {
      implement: async () => ({
        done: false,
        reason: "fast gate not green after the escalation ladder",
      }),
    };

    await runGreenfield(dir, s, deps);

    const onDisk = await loadState(dir);
    const parked = onDisk?.features.find((f) => f.id === "a");

    expect(parked?.lastError).toBe(
      "fast gate not green after the escalation ladder"
    );
  });

  test("parked + handoff round-trip through saveState + loadState", async () => {
    const s = state("a");

    s.features[0]!.parked = true;
    s.features[0]!.handoff = {
      block: "test-block",
      rungHistory: ["R1", "R2"],
      errors: ["error"],
      ask: "help",
      resumable: true,
      resume: { triedLevers: ["R1", "R2"] },
    };

    await saveState(dir, s);

    const loaded = await loadState(dir);

    expect(loaded?.features[0]?.parked).toBe(true);
    expect(loaded?.features[0]?.handoff?.block).toBe("test-block");
    expect(loaded?.features[0]?.handoff?.rungHistory).toEqual(["R1", "R2"]);
    expect(loaded?.features[0]?.handoff?.resume).toEqual({
      triedLevers: ["R1", "R2"],
    });
  });

  test("renderProgress shows parked features distinctly with [~] and (parked) note", () => {
    const s = state("a", "b", "c");

    s.features[0]!.passes = true;
    s.features[1]!.parked = true;

    const md = renderProgress(s);

    expect(md).toContain("- [x] a");
    expect(md).toContain("- [~] b");
    expect(md).toContain("(parked)");
    expect(md).toContain("- [ ] c");
  });

  test("FIX 3: runGreenfield returns needs-infra when implement returns infra error", async () => {
    const s = state("a", "b");
    let implementCalls = 0;
    const eventReports: string[] = [];

    const deps: IGreenfieldDeps = {
      implement: async (f) => {
        implementCalls += 1;

        // First feature returns infra error
        if (f.id === "a") {
          return {
            done: false,
            infra: "API server is not responding (ECONNREFUSED)",
          };
        }

        // This should NOT be called
        return { done: true };
      },
    };

    const result = await runGreenfield(dir, s, deps, {
      onEvent: (ev) => {
        if (typeof ev.message === "string") {
          eventReports.push(ev.message);
        }
      },
    });

    // Should return needs-infra status
    expect(result.status).toBe("needs-infra");
    // Infra message should be propagated
    expect(result.infra).toContain("ECONNREFUSED");
    // Only the first feature should be attempted
    expect(implementCalls).toBe(1);
    // No further features should be processed (feature 'b' not attempted)
    expect(s.features[1]?.passes).toBe(false);
    // An event should be reported
    expect(
      eventReports.some((m) => m.includes("infrastructure unavailable"))
    ).toBe(true);
  });
});
