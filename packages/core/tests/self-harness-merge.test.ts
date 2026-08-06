import { test, expect, describe } from "bun:test";
import { mergeOutcomes } from "../src/self-harness";
import type { IEvaluateOutcome } from "../src/self-harness";
import type { IRunRecord } from "../src/eval";

/**
 * The seam that made the graded score inert in production.
 *
 * Every real session evaluates TASK BY TASK — that is what lets one endpoint
 * flap cost one task's re-run instead of the whole split — and merges the
 * per-task outcomes here. The merge rebuilt ISplitScore field by field and
 * omitted `avgProgress`, so the score was computed correctly per task and
 * dropped before the acceptance rule saw it: `progressDecision` got undefined,
 * failed closed, and rejected every equal-pass candidate with "progress was not
 * measured on both splits".
 *
 * It survived 16 review rounds and 4,483 tests because every test drove
 * `evaluateHarness` or `acceptanceDecision` directly. Nothing crossed the join.
 */

function outcome(records: IRunRecord[]): IEvaluateOutcome {
  return {
    records,
    runs: [],
    score: {
      passed: records.filter((r) => r.passed).length,
      runs: records.length,
      errored: 0,
      avgQuality: 0,
      avgLoc: 0,
      avgProgress: undefined,
      perTask: {},
    },
  };
}

const run = (
  label: string,
  passed: boolean,
  progress?: number
): IRunRecord => ({
  label,
  passed,
  cycles: 1,
  ms: 0,
  ...(progress === undefined ? {} : { progress }),
});

describe("mergeOutcomes carries the graded score across the join", () => {
  test("avgProgress survives the merge", () => {
    const merged = mergeOutcomes([
      outcome([run("a", false, 0.4)]),
      outcome([run("b", false, 0.8)]),
    ]);

    expect(merged.score.avgProgress).toBeCloseTo(0.6, 5);
  });

  test("it is a mean over RUNS, not over tasks", () => {
    // A task measured twice weighs twice. Averaging the per-task means would
    // give a 1-run task the same say as a 3-run one.
    const merged = mergeOutcomes([
      outcome([run("a", false, 0), run("a", false, 0), run("a", false, 0)]),
      outcome([run("b", false, 1)]),
    ]);

    expect(merged.score.avgProgress).toBeCloseTo(0.25, 5);
  });

  test("an errored run carries no score and is skipped, not read as zero", () => {
    // Errored records are pushed without `progress` — an outage is not a run
    // that made no progress, and counting it as 0 would put weather into the
    // graded figure.
    const merged = mergeOutcomes([
      outcome([run("a", false, 0.5)]),
      outcome([run("b", false)]),
    ]);

    expect(merged.score.avgProgress).toBeCloseTo(0.5, 5);
  });

  test("a split with nothing scored stays unmeasured, not zero", () => {
    const merged = mergeOutcomes([outcome([run("a", false)])]);

    expect(merged.score.avgProgress).toBeUndefined();
  });

  test("the counts still sum", () => {
    const merged = mergeOutcomes([
      outcome([run("a", true, 1)]),
      outcome([run("b", false, 0.2), run("b", true, 1)]),
    ]);

    expect(merged.score.passed).toBe(2);
    expect(merged.score.runs).toBe(3);
  });
});

describe("the merge cannot silently drop a field", () => {
  /**
   * The structural version of this test, and the one that would have caught the
   * original bug. Asserting `avgProgress` survives only covers the field I
   * already know about — a hand-written fixture listing every key cannot notice
   * the merge omitting a key, which is exactly how `avgProgress` was lost for a
   * week.
   *
   * What this buys, precisely: a new OPTIONAL field can be added to the fixture
   * and dropped by the merge, and these turn red. A new REQUIRED field is a
   * compile error in the fixture first, so someone edits this file either way —
   * the value there is that adding it to the fixture is enough, with no separate
   * assertion to remember. It is not automatic coverage of a field nobody
   * touches, and claiming that was overselling it.
   */
  test("every key of the input score appears on the merged score", () => {
    const input = outcome([run("a", true, 1)]);
    const merged = mergeOutcomes([input]);

    expect(Object.keys(merged.score).sort()).toEqual(
      Object.keys(input.score).sort()
    );
  });

  test("and none of them is undefined when the input had a value", () => {
    // Shape alone is not enough: a merge could carry the key and drop the
    // value, which is what `avgProgress: undefined` would have looked like.
    const input: IEvaluateOutcome = {
      records: [run("a", false, 0.5)],
      runs: [],
      score: {
        passed: 0,
        runs: 1,
        errored: 0,
        avgQuality: 4,
        avgLoc: 12,
        avgProgress: 0.5,
        perTask: {},
      },
    };
    const merged = mergeOutcomes([input]);

    // A Map off Object.entries, not a dynamic index. Indexing a known-type
    // object by a runtime string needs an `as` to compile, and the rule against
    // those exists precisely so a test cannot silence the type system to reach
    // its own assertion.
    const carried = new Map(Object.entries(merged.score));

    // No skip list. The previous `typeof !== "object"` guard, and the named set
    // that replaced it, were both inert: `perTask` is `{}`, which is defined, so
    // removing either changed nothing about pass or fail. Ceremony that looks
    // like coverage is worse than none — every key is asserted, and `perTask`
    // gets a real test of its own below.
    for (const [key, value] of Object.entries(input.score)) {
      if (value !== undefined) {
        expect(carried.get(key)).toBeDefined();
      }
    }
  });
});

describe("an empty merge", () => {
  test("yields nothing measured, not a zero", () => {
    // Reachable: evaluateSplitResilient pushes no outcome when the task list is
    // empty, or when every attempt for every task throws. A zero here would be
    // a measured claim about a split that never ran, and the acceptance rule
    // reads `undefined` as fail-closed precisely so that cannot happen.
    const merged = mergeOutcomes([]);

    expect(merged.score.avgProgress).toBeUndefined();
    expect(merged.score.runs).toBe(0);
    expect(merged.score.passed).toBe(0);
    expect(merged.score.errored).toBe(0);
  });
});

describe("meanOfSignaled — the quality and concision means", () => {
  /**
   * This helper came across from an untested script along with the merge, and
   * nothing asserted what it computes: every fixture set both to 0 and the only
   * assertion that touched them was `toBeDefined()`, which any number passes.
   * The convention it encodes is not obvious and is easy to "simplify" away.
   */
  const scored = (avgQuality: number, avgLoc: number): IEvaluateOutcome => ({
    records: [],
    runs: [],
    score: {
      passed: 0,
      runs: 0,
      errored: 0,
      avgQuality,
      avgLoc,
      perTask: {},
    },
  });

  test("averages only the outcomes that carry a signal", () => {
    // 0 means "not measured here" — quality needs a judge call and loc needs a
    // shipped solution, so most tasks have neither. Counting the zeros would
    // drag the mean toward however many tasks failed.
    const merged = mergeOutcomes([scored(4, 100), scored(0, 0), scored(2, 50)]);

    expect(merged.score.avgQuality).toBeCloseTo(3, 5);
    expect(merged.score.avgLoc).toBeCloseTo(75, 5);
  });

  test("no signal at all stays 0, not NaN", () => {
    const merged = mergeOutcomes([scored(0, 0), scored(0, 0)]);

    expect(merged.score.avgQuality).toBe(0);
    expect(merged.score.avgLoc).toBe(0);
  });
});

describe("the collections merge, not just the counts", () => {
  /**
   * Untouched by every other test here, because every fixture left `runs` and
   * `perTask` empty and the structural check only compares keys of `score` —
   * `records` and `runs` live one level up on IEvaluateOutcome. Replacing either
   * flatMap with `[]` passed the whole suite.
   */
  const withRuns = (
    task: string,
    passed: boolean,
    avgCycles: number
  ): IEvaluateOutcome => ({
    records: [run(task, passed, 0.5)],
    runs: [{ taskId: task, passed, events: [] }],
    score: {
      passed: passed ? 1 : 0,
      runs: 1,
      errored: 0,
      avgQuality: 0,
      avgLoc: 0,
      perTask: {
        [task]: {
          label: task,
          runs: 1,
          passed: passed ? 1 : 0,
          passRate: passed ? 1 : 0,
          avgCycles,
          avgTurnsToGreen: null,
          avgMs: 0,
          avgQuality: 0,
          avgLoc: 0,
          failureClasses: {},
        },
      },
    },
  });

  test("records and runs are concatenated, not dropped", () => {
    const merged = mergeOutcomes([
      withRuns("a", true, 3),
      withRuns("b", false, 9),
    ]);

    expect(merged.records).toHaveLength(2);
    expect(merged.runs.map((r) => r.taskId)).toEqual(["a", "b"]);
  });

  test("perTask carries every task's summary through", () => {
    // The acceptance rule's cycle guard reads perTask; an entry lost here is a
    // task the blowup check silently stops seeing.
    const merged = mergeOutcomes([
      withRuns("a", true, 3),
      withRuns("b", false, 9),
    ]);

    expect(Object.keys(merged.score.perTask).sort()).toEqual(["a", "b"]);
    expect(merged.score.perTask.b?.avgCycles).toBe(9);
  });
});
