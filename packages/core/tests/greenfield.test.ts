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
      implement: async (f) => void implemented.push(f.id),
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

  test("gives up on a non-converging feature after maxAttempts (status stuck)", async () => {
    const s = state("a", "b");
    let aCalls = 0;
    const deps: IGreenfieldDeps = {
      implement: async (f) => {
        if (f.id === "a") {
          aCalls += 1;
        }
      },
      // 'a' never passes; 'b' would, but the loop never reaches it.
      evaluate: async (f) => ({ passed: f.id !== "a", notes: "" }),
    };

    const res = await runGreenfield(dir, s, deps, { maxAttemptsPerFeature: 3 });

    expect(res.status).toBe("stuck");
    expect(res.stuckFeature).toBe("a");
    expect(aCalls).toBe(3); // exactly maxAttempts, then it bails
    expect(s.features[1]?.passes).toBe(false); // 'b' never attempted
  });

  test("rescue that lands green before parking ticks the feature (not stuck)", async () => {
    const s = state("a");
    let rescueCalls = 0;
    const deps: IGreenfieldDeps = {
      implement: async () => undefined,
      // Fails every normal attempt; passes only after rescue has run.
      evaluate: async () => ({ passed: rescueCalls > 0, notes: "" }),
      rescue: async () => {
        rescueCalls += 1;

        return true;
      },
    };

    const res = await runGreenfield(dir, s, deps, { maxAttemptsPerFeature: 3 });

    expect(res.status).toBe("done");
    expect(rescueCalls).toBe(1); // one shot, right before parking
    expect(s.features[0]?.passes).toBe(true);
  });

  test("rescue is attempted once, then parks stuck if it can't help", async () => {
    const s = state("a");
    let rescueCalls = 0;
    const deps: IGreenfieldDeps = {
      implement: async () => undefined,
      evaluate: async () => ({ passed: false, notes: "" }),
      rescue: async () => {
        rescueCalls += 1;

        return false; // expert unavailable / no fix
      },
    };

    const res = await runGreenfield(dir, s, deps, { maxAttemptsPerFeature: 3 });

    expect(res.status).toBe("stuck");
    expect(rescueCalls).toBe(1);
  });

  test("rescue that applies a fix but still fails re-eval parks stuck (no loop)", async () => {
    const s = state("a");
    let rescueCalls = 0;
    const deps: IGreenfieldDeps = {
      implement: async () => undefined,
      evaluate: async () => ({ passed: false, notes: "" }),
      rescue: async () => {
        rescueCalls += 1;

        return true; // applied a change, but re-eval still red
      },
    };

    const res = await runGreenfield(dir, s, deps, { maxAttemptsPerFeature: 3 });

    expect(res.status).toBe("stuck");
    expect(rescueCalls).toBe(1); // exactly once — never loops
  });

  test("a feature that passes on its 2nd attempt is not counted stuck", async () => {
    const s = state("a");
    let calls = 0;
    const deps: IGreenfieldDeps = {
      implement: async () => void (calls += 1),
      evaluate: async () => ({ passed: calls >= 2, notes: "" }),
    };

    const res = await runGreenfield(dir, s, deps, { maxAttemptsPerFeature: 3 });

    expect(res.status).toBe("done");
    expect(s.features[0]?.attempts).toBe(2);
  });

  test("resumes from persisted state (already-passing features are skipped)", async () => {
    const s = state("a", "b");

    s.features[0]!.passes = true; // 'a' already done
    const implemented: string[] = [];
    const deps: IGreenfieldDeps = {
      implement: async (f) => void implemented.push(f.id),
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

  test("a repeatedly-crashing feature still reaches `stuck` across resumes", async () => {
    const deps: IGreenfieldDeps = {
      implement: async () => {
        throw new Error("boom");
      },
      evaluate: async () => ({ passed: true, notes: "" }),
    };

    // Each run crashes on its single attempt but persists the bump; resuming from
    // disk three times exhausts maxAttempts instead of looping on attempt 0.
    for (let i = 0; i < 3; i += 1) {
      const resumed = (await loadState(dir)) ?? state("a");

      await expect(
        runGreenfield(dir, resumed, deps, { maxAttemptsPerFeature: 3 })
      ).rejects.toThrow("boom");
    }

    const final = (await loadState(dir)) ?? state("a");
    const res = await runGreenfield(dir, final, deps, {
      maxAttemptsPerFeature: 3,
    });

    expect(res.status).toBe("stuck");
    expect(res.stuckFeature).toBe("a");
  });

  test("writes progress.md as it goes", async () => {
    const s = state("a");
    const deps: IGreenfieldDeps = {
      implement: async () => undefined,
      evaluate: async () => ({ passed: true, notes: "" }),
    };

    await runGreenfield(dir, s, deps);

    const md = await readFile(join(greenfieldDir(dir), "progress.md"), "utf8");

    expect(md).toContain("1/1 features verified");
  });
});
