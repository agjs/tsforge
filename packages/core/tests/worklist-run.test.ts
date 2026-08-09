import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runWorklist,
  prepareWorklistState,
  tickWorklistFile,
  WORKLIST_STATE,
} from "../src/loop/worklist";
import {
  loadState,
  hasState,
  saveState,
  greenfieldDir,
} from "../src/loop/greenfield";
import type { IGreenfieldDeps, IFeature } from "../src/loop/greenfield";
import type { IHandoff } from "../src/loop/loop.types";

function handoff(): IHandoff {
  return {
    block: "test",
    rungHistory: ["R1", "R2", "R3", "R4"],
    errors: ["still broken"],
    ask: "help",
    resumable: true,
    resume: { triedLevers: ["R1", "R2", "R3", "R4"] },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tsforge-wl-run-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("prepareWorklistState", () => {
  test("parses PLAN.md into features when no prior state", async () => {
    await writeFile(
      join(dir, "PLAN.md"),
      "- [ ] First item\n- [x] Already done\n- [ ] Third item\n"
    );

    const state = await prepareWorklistState(dir, { goal: "from plan" });

    expect(state?.features.map((f) => f.desc)).toEqual([
      "First item",
      "Third item",
    ]);
    expect(await hasState(dir, WORKLIST_STATE)).toBe(true);
    expect(await hasState(dir)).toBe(false);
  });

  test("resumes from .tsforge/worklist/ instead of re-parsing", async () => {
    await saveState(
      dir,
      {
        goal: "prior",
        features: [
          { id: "a", desc: "A", passes: true, attempts: 1 },
          { id: "b", desc: "B", passes: false, attempts: 0 },
        ],
      },
      WORKLIST_STATE
    );
    await writeFile(join(dir, "PLAN.md"), "- [ ] Should not replace\n");

    const state = await prepareWorklistState(dir, { goal: "ignored" });

    expect(state?.goal).toBe("prior");
    expect(state?.features.map((f) => f.id)).toEqual(["a", "b"]);
    expect(state?.features[0]?.passes).toBe(true);
  });
});

describe("runWorklist", () => {
  test("drives three items: parks failing middle item, still attempts the third, revisits once", async () => {
    const order: string[] = [];
    let bAttempts = 0;

    const deps: IGreenfieldDeps = {
      implement: async (feature: IFeature) => {
        order.push(feature.id);

        if (feature.id === "b") {
          bAttempts += 1;

          return { done: false, handoff: handoff(), reason: "cannot pass" };
        }

        return { done: true };
      },
    };

    const state = {
      goal: "list",
      features: [
        { id: "a", desc: "A", passes: false, attempts: 0 },
        { id: "b", desc: "B", passes: false, attempts: 0 },
        { id: "c", desc: "C", passes: false, attempts: 0 },
      ],
    };

    const result = await runWorklist(dir, state, deps);

    expect(result.status).toBe("stuck");
    expect(result.stuckFeature).toBe("b");
    // main: a, b(park), c — revisit: b again
    expect(order).toEqual(["a", "b", "c", "b"]);
    expect(bAttempts).toBe(2);
    expect(result.features.find((f) => f.id === "a")?.passes).toBe(true);
    expect(result.features.find((f) => f.id === "c")?.passes).toBe(true);
    expect(result.features.find((f) => f.id === "b")?.parked).toBe(true);

    const progress = await readFile(
      join(greenfieldDir(dir, WORKLIST_STATE), "progress.md"),
      "utf8"
    );

    expect(progress).toContain("- [x] a");
    expect(progress).toContain("- [~] b");
    expect(progress).toContain("- [x] c");
  });

  test("resume skips already-passing features", async () => {
    const attempted: string[] = [];
    const deps: IGreenfieldDeps = {
      implement: async (feature) => {
        attempted.push(feature.id);

        return { done: true };
      },
    };

    await saveState(
      dir,
      {
        goal: "list",
        features: [
          { id: "a", desc: "A", passes: true, attempts: 1 },
          { id: "b", desc: "B", passes: false, attempts: 0 },
        ],
      },
      WORKLIST_STATE
    );

    const state = await loadState(dir, WORKLIST_STATE);

    expect(state).not.toBeNull();

    const result = await runWorklist(dir, state!, deps);

    expect(result.status).toBe("done");
    expect(attempted).toEqual(["b"]);
  });
});

describe("tickWorklistFile", () => {
  test("marks matching open checkboxes as done when opt-in", async () => {
    const path = join(dir, "PLAN.md");

    await writeFile(
      path,
      "## Section\n\n- [ ] First open item\n- [ ] Second open item\n"
    );

    await tickWorklistFile(path, [
      {
        id: "first-open-item",
        desc: "First open item",
        passes: true,
        attempts: 1,
      },
      {
        id: "second-open-item",
        desc: "Second open item",
        passes: false,
        attempts: 0,
      },
    ]);

    const text = await readFile(path, "utf8");

    expect(text).toContain("- [x] First open item");
    expect(text).toContain("- [ ] Second open item");
  });
});
