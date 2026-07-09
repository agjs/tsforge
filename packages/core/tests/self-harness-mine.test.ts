import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import {
  mineWeaknesses,
  dominantSignal,
  type IMinedRun,
} from "../src/self-harness/mine";
import {
  resolveSplits,
  listCorpusTasks,
  DEFAULT_HELD_IN,
  DEFAULT_HELD_OUT,
} from "../src/self-harness/split";
import type { ILoopEvent } from "../src/loop/loop.types";

const CORPUS = join(import.meta.dir, "..", "..", "..", "evals", "corpus");

function ev(
  partial: Partial<ILoopEvent> & { kind: ILoopEvent["kind"] }
): ILoopEvent {
  return { task: "t", message: "", ...partial };
}

/** A run that ends stuck with a red gate dominated by the given rules. */
function failedGateRun(taskId: string, rules: string[]): IMinedRun {
  return {
    taskId,
    passed: false,
    events: [
      ev({ kind: "start", message: "start" }),
      ev({ kind: "cycle", message: "cycle 1" }),
      ev({
        kind: "validated",
        passed: false,
        errors: rules.length,
        rules,
        message: `task ${taskId} · turn 1: red (${rules.length} error(s))`,
      }),
      ev({ kind: "stuck", message: "turn cap reached" }),
    ],
  };
}

/** A run that fails via repeated edit rejections. */
function editRejectRun(taskId: string): IMinedRun {
  const rejects = Array.from({ length: 4 }, (_, i) =>
    ev({
      kind: "tool",
      message: `tool_rejected: edit target not found (attempt ${i + 1})`,
    })
  );

  return {
    taskId,
    passed: false,
    events: [
      ev({ kind: "start", message: "start" }),
      ...rejects,
      ev({ kind: "stuck", message: "no progress" }),
    ],
  };
}

function passedRun(taskId: string): IMinedRun {
  return {
    taskId,
    passed: true,
    events: [
      ev({ kind: "start", message: "start" }),
      ev({ kind: "validated", passed: true, message: "GREEN" }),
      ev({ kind: "done", message: "done" }),
    ],
  };
}

describe("dominantSignal", () => {
  test("terminal booleans outrank tallies; largest tally wins otherwise", () => {
    const base = {
      repairs: 0,
      salvages: 0,
      editRejects: 0,
      degenerated: false,
      timedOut: false,
      toolUseFailed: false,
      tsErrors: 0,
      lintErrors: 0,
      missingModule: 0,
      browser: 0,
      build: 0,
    };

    expect(dominantSignal({ ...base, degenerated: true, editRejects: 9 })).toBe(
      "degenerated"
    );
    expect(dominantSignal({ ...base, editRejects: 3, salvages: 1 })).toBe(
      "edit-rejects"
    );
    // repairs only dominate as a LOOP (≥3) — two repair rounds are normal
    expect(dominantSignal({ ...base, repairs: 2 })).toBe("none");
    expect(dominantSignal({ ...base, repairs: 5 })).toBe("repair-loop");
    expect(dominantSignal(base)).toBe("none");
  });
});

describe("mineWeaknesses", () => {
  test("clusters failures by exact signature and ranks by support", () => {
    const bundle = mineWeaknesses([
      passedRun("math"),
      failedGateRun("slugify", ["TS2307", "TS2307"]),
      failedGateRun("debounce", ["TS2307"]),
      editRejectRun("checkout"),
    ]);

    expect(bundle.totalRuns).toBe(4);
    expect(bundle.failedRuns).toBe(3);
    expect(bundle.patterns).toHaveLength(2);

    // The 2-run hallucinated-import cluster ranks first (support desc)
    const [first, second] = bundle.patterns;

    expect(first?.support).toBe(2);
    expect(first?.failureClass).toBe("hallucinated-import");
    expect(first?.taskIds).toEqual(["slugify", "debounce"]);
    expect(first?.verifierEvidence).toContain("TS2307");
    expect(first?.mechanism.length).toBeGreaterThan(0);

    expect(second?.support).toBe(1);
    expect(second?.dominantSignal).toBe("edit-rejects");
    expect(second?.mechanism).toContain("don't match the working tree");
  });

  test("a fully green round yields an empty pattern list, not an error", () => {
    const bundle = mineWeaknesses([passedRun("math"), passedRun("slugify")]);

    expect(bundle.failedRuns).toBe(0);
    expect(bundle.patterns).toEqual([]);
  });

  test("is deterministic: same input, same bundle", () => {
    const runs = [
      failedGateRun("slugify", ["no-as"]),
      editRejectRun("checkout"),
    ];

    expect(JSON.stringify(mineWeaknesses(runs))).toBe(
      JSON.stringify(mineWeaknesses(runs))
    );
  });

  test("trace snippets carry the failing gate line, truncated", () => {
    const bundle = mineWeaknesses([failedGateRun("slugify", ["TS2532"])]);
    const snippets = bundle.patterns[0]?.traceSnippets ?? [];

    expect(snippets.some((s) => s.startsWith("gate: task slugify"))).toBe(true);

    for (const s of snippets) {
      expect(s.length).toBeLessThanOrEqual(160);
    }
  });
});

describe("resolveSplits", () => {
  test("defaults are disjoint, non-empty, and exist in the corpus", async () => {
    const splits = await resolveSplits(CORPUS);

    expect(splits.heldIn.length).toBeGreaterThan(0);
    expect(splits.heldOut.length).toBeGreaterThan(0);

    const all = await listCorpusTasks(CORPUS);

    for (const id of [...splits.heldIn, ...splits.heldOut]) {
      expect(all).toContain(id);
    }

    expect(splits.heldIn.filter((id) => splits.heldOut.includes(id))).toEqual(
      []
    );
    // pinned defaults (update if the corpus changes)
    expect(splits.heldIn).toEqual([...DEFAULT_HELD_IN]);
    expect(splits.heldOut).toEqual([...DEFAULT_HELD_OUT]);
  });

  test("explicit lists are validated: unknown id and overlap both throw", async () => {
    await expect(
      resolveSplits(CORPUS, ["nonexistent"], ["math"])
    ).rejects.toThrow(/unknown corpus task/);
    await expect(resolveSplits(CORPUS, ["math"], ["math"])).rejects.toThrow(
      /disjoint/
    );
    await expect(resolveSplits(CORPUS, ["math"], [])).rejects.toThrow(
      /non-empty/
    );
  });
});
