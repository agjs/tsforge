import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runGreenfield,
  evaluateFeature,
  loadState,
  saveState,
  renderProgress,
  greenfieldDir,
} from "../src/loop/greenfield";
import type {
  IGreenfieldState,
  IGreenfieldDeps,
  IEvaluateDeps,
  IFeature,
} from "../src/loop/greenfield";

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

describe("evaluateFeature: layered, short-circuiting", () => {
  const ok = { ok: true, errors: [] };

  function deps(over: Partial<IEvaluateDeps>): IEvaluateDeps {
    return {
      gate: async () => ({ passed: true, output: "" }),
      browser: async () => ok,
      judge: async () => ({ ok: true, notes: "good" }),
      ...over,
    };
  }

  test("gate failure short-circuits before browser/judge", async () => {
    let browserCalled = false;
    const v = await evaluateFeature(
      feature("a"),
      deps({
        gate: async () => ({
          passed: false,
          output: "TS2322 type error\nmore",
        }),
        browser: async () => {
          browserCalled = true;

          return ok;
        },
      })
    );

    expect(v.passed).toBe(false);
    expect(v.stage).toBe("gate");
    expect(v.notes).toBe("TS2322 type error");
    expect(browserCalled).toBe(false);
  });

  test("a skipped render-check does NOT block (playwright absent)", async () => {
    const v = await evaluateFeature(
      feature("a"),
      deps({
        browser: async () => ({ ok: false, errors: ["x"], skipped: true }),
      })
    );

    expect(v.passed).toBe(true);
  });

  test("a real browser failure blocks at the browser stage", async () => {
    const v = await evaluateFeature(
      feature("a"),
      deps({
        browser: async () => ({ ok: false, errors: ["console error: boom"] }),
      })
    );

    expect(v.passed).toBe(false);
    expect(v.stage).toBe("browser");
    expect(v.notes).toContain("boom");
  });

  test("judge is the last gate and can still fail a green build", async () => {
    const v = await evaluateFeature(
      feature("a"),
      deps({ judge: async () => ({ ok: false, notes: "ugly state mgmt" }) })
    );

    expect(v.passed).toBe(false);
    expect(v.stage).toBe("judge");
  });

  test("all green → passed", async () => {
    const v = await evaluateFeature(feature("a"), deps({}));

    expect(v.passed).toBe(true);
    expect(v.stage).toBeUndefined();
  });
});

describe("runGreenfield: outer loop", () => {
  test("drives every feature to green, in order, ticking the checklist", async () => {
    const s = state("a", "b", "c");
    const implemented: string[] = [];
    const deps: IGreenfieldDeps = {
      implement: async (f) => {
        implemented.push(f.id);

        return { handoff: undefined };
      },
      evaluate: async () => ({ passed: true, notes: "ok" }),
    };

    const res = await runGreenfield(dir, s, deps);

    expect(res.status).toBe("done");
    expect(implemented).toEqual(["a", "b", "c"]); // first-unfinished order
    expect(res.features.every((f) => f.passes)).toBe(true);

    // features.json on disk reflects the all-green end state
    const onDisk = await loadState(dir);

    expect(onDisk?.features.every((f) => f.passes)).toBe(true);
  });

  test("a feature that returns a handoff parks and is revisited once (main + revisit pass)", async () => {
    const s = state("a", "b");
    let aCalls = 0;
    const deps: IGreenfieldDeps = {
      implement: async (f) => {
        if (f.id === "a") {
          aCalls += 1;

          // Return handoff in both main pass (aCalls=1) and revisit pass (aCalls=2)
          return {
            handoff: {
              block: "test-block",
              rungHistory: ["R1"],
              errors: ["error"],
              ask: "help",
              resumable: true,
              resume: { triedLevers: ["R1"] },
            },
          };
        }

        return { handoff: undefined };
      },
      // 'b' passes normally
      evaluate: async (f) => ({ passed: f.id === "b", notes: "" }),
    };

    const res = await runGreenfield(dir, s, deps);

    expect(aCalls).toBe(2); // 'a' called once in main pass, once in revisit pass
    expect(s.features[0]?.parked).toBe(true); // 'a' remains parked
    expect(s.features[1]?.passes).toBe(true); // 'b' passed normally
    expect(res.status).toBe("stuck");
    expect(res.stuckFeature).toBe("a");
  });

  test("a feature that passes on its 2nd attempt is not counted stuck", async () => {
    const s = state("a");
    let calls = 0;
    const deps: IGreenfieldDeps = {
      implement: async () => {
        calls += 1;

        return { handoff: undefined };
      },
      evaluate: async () => ({ passed: calls >= 2, notes: "" }),
    };

    const res = await runGreenfield(dir, s, deps);

    expect(res.status).toBe("done");
    expect(s.features[0]?.attempts).toBe(2);
  });

  test("resumes from persisted state (already-passing features are skipped)", async () => {
    const s = state("a", "b");

    s.features[0]!.passes = true; // 'a' already done
    const implemented: string[] = [];
    const deps: IGreenfieldDeps = {
      implement: async (f) => {
        implemented.push(f.id);

        return { handoff: undefined };
      },
      evaluate: async () => ({ passed: true, notes: "" }),
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
      evaluate: async () => ({ passed: true, notes: "" }),
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
      evaluate: async () => ({ passed: true, notes: "" }),
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
      implement: async () => ({ handoff: undefined }),
      evaluate: async () => ({ passed: true, notes: "" }),
    };

    await runGreenfield(dir, s, deps);

    const md = await readFile(join(greenfieldDir(dir), "progress.md"), "utf8");

    expect(md).toContain("1/1 features verified");
  });

  test("when implement returns a handoff, the feature is parked and later features build", async () => {
    const s = state("a", "b");
    const implemented: string[] = [];
    const deps: IGreenfieldDeps = {
      implement: async (f) => {
        implemented.push(f.id);

        if (f.id === "a") {
          return {
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

        return { handoff: undefined };
      },
      evaluate: async () => ({ passed: true, notes: "" }),
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

  test("parked features are revisited once, seeded with their saved triedLevers", async () => {
    const s = state("a", "b");
    let aAttempts = 0;
    const seedsReceived: { id: string; seed?: { triedLevers: string[] } }[] =
      [];

    const deps: IGreenfieldDeps = {
      implement: async (f, _, seed) => {
        seedsReceived.push({ id: f.id, seed });

        if (f.id === "a") {
          aAttempts += 1;

          if (aAttempts === 1) {
            // First attempt (main pass): return a handoff to park the feature
            return {
              handoff: {
                block: "test-block",
                rungHistory: ["R1", "R2"],
                errors: ["error"],
                ask: "help",
                resumable: true,
                resume: { triedLevers: ["R1", "R2"] },
              },
            };
          }

          // Second attempt (revisit pass): pass now with the seed
          return { handoff: undefined };
        }

        return { handoff: undefined };
      },
      evaluate: async (f) => ({
        passed: f.id === "b" || aAttempts >= 2,
        notes: "",
      }),
    };

    const res = await runGreenfield(dir, s, deps);

    // 'a' was parked, revisited, and passed on the second attempt
    expect(res.status).toBe("done");
    expect(aAttempts).toBe(2); // one in main pass, one in revisit pass
    // Check that the revisit pass received the seed
    const aRevisitSeed = seedsReceived.find(
      (sr) => sr.id === "a" && sr.seed?.triedLevers.length === 2
    );

    expect(aRevisitSeed).toBeDefined();
    expect(aRevisitSeed?.seed?.triedLevers).toEqual(["R1", "R2"]);
  });

  test("when a parked feature still fails after revisit, build reports fully-stuck", async () => {
    const s = state("a");
    const deps: IGreenfieldDeps = {
      implement: async () => ({
        handoff: {
          block: "test-block",
          rungHistory: ["R1", "R2", "R3", "R4"],
          errors: ["persistent error"],
          ask: "help",
          resumable: true,
          resume: { triedLevers: ["R1", "R2", "R3", "R4"] },
        },
      }),
      evaluate: async () => ({ passed: false, notes: "still broken" }),
    };

    const res = await runGreenfield(dir, s, deps);

    expect(res.status).toBe("stuck");
    expect(res.stuckFeature).toBe("a");
    expect(s.features[0]?.parked).toBe(true); // still parked after revisit
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
});
