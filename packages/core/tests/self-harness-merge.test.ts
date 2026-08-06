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

describe("quality and concision are averaged over TASKS, not runs", () => {
  /**
   * The SUBSTRATE changed with this PR — they are derived from records through
   * `splitScore` now rather than averaged from per-outcome scores — but the
   * weighting did not, and an earlier name for this block ("come from the RUNS
   * now") got that wrong. `splitScore` computes both as a mean over TASK
   * summaries, deliberately unlike `avgProgress`, which is a mean over runs.
   *
   * The reason is three lines from each other in that function: every completed
   * run has a progress score, so a task measured twice should weigh twice; but
   * quality needs a judge call and loc needs a shipped solution, so most runs
   * have neither and a run-weighted mean would be decided by which tasks
   * happened to pass.
   */
  const judged = (task: string, quality: number, loc: number): IRunRecord => ({
    label: task,
    passed: true,
    cycles: 1,
    ms: 0,
    quality,
    loc,
    progress: 1,
  });

  test("only runs that carry a signal are averaged", () => {
    const merged = mergeOutcomes([
      outcome([judged("a", 4, 100)]),
      outcome([run("b", true, 1)]),
      outcome([judged("c", 2, 50)]),
    ]);

    expect(merged.score.avgQuality).toBeCloseTo(3, 5);
    expect(merged.score.avgLoc).toBeCloseTo(75, 5);
  });

  test("no signal at all stays 0, not NaN", () => {
    const merged = mergeOutcomes([
      outcome([run("a", true, 1)]),
      outcome([run("b", true, 1)]),
    ]);

    expect(merged.score.avgQuality).toBe(0);
    expect(merged.score.avgLoc).toBe(0);
  });
});

describe("the collections merge, not just the counts", () => {
  /**
   * Untouched by every other test here, because every fixture left `runs` empty
   * and the structural check only compares keys of `score` — `records` and
   * `runs` live one level up on IEvaluateOutcome. Replacing either flatMap with
   * `[]` passed the whole suite.
   */
  const withRuns = (
    task: string,
    passed: boolean,
    cycles: number
  ): IEvaluateOutcome => ({
    records: [{ label: task, passed, cycles, ms: 0, progress: passed ? 1 : 0 }],
    runs: [{ taskId: task, passed, events: [] }],
    score: {
      passed: passed ? 1 : 0,
      runs: 1,
      errored: 0,
      avgQuality: 0,
      avgLoc: 0,
      perTask: {},
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

  test("perTask carries every task through, derived from its runs", () => {
    // The acceptance rule's cycle guard reads perTask; a task missing here is
    // one the blowup check silently stops seeing.
    const merged = mergeOutcomes([
      withRuns("a", true, 3),
      withRuns("b", false, 9),
    ]);

    expect(Object.keys(merged.score.perTask).sort()).toEqual(["a", "b"]);
    expect(merged.score.perTask.b?.avgCycles).toBe(9);
  });

  test("two outcomes for ONE task merge instead of overwriting", () => {
    // The old merge kept whichever entry came last beside a total counting
    // both, so perTask described a fraction of the runs it was compared
    // against — and perTask.avgCycles is what the blowup guard reads. Deriving
    // from records makes summarize group them.
    const merged = mergeOutcomes([
      withRuns("a", true, 2),
      withRuns("a", true, 8),
    ]);

    expect(merged.score.runs).toBe(2);
    expect(merged.score.perTask.a?.runs).toBe(2);
    expect(merged.score.perTask.a?.avgCycles).toBe(5);
  });
});

describe("errored is the one count that cannot come from records", () => {
  test("it sums across outcomes", () => {
    // Not because an errored run leaves no record — it leaves one, a
    // placeholder pushed on the catch path, counted in `runs` like any other.
    // What that record lacks is a field marking it errored: it is
    // indistinguishable from a run that failed honestly. So the count travels
    // beside the records rather than being derived from them.
    //
    // The fixture is shaped like a real outcome for that reason: errored: 2
    // means two placeholder records, not one.
    const withErrors = (n: number): IEvaluateOutcome => ({
      records: Array.from({ length: n }, () => ({
        label: "t",
        passed: false,
        cycles: 0,
        ms: 0,
      })),
      runs: [],
      score: {
        passed: 0,
        runs: n,
        errored: n,
        avgQuality: 0,
        avgLoc: 0,
        perTask: {},
      },
    });
    const merged = mergeOutcomes([withErrors(2), withErrors(3)]);

    expect(merged.score.errored).toBe(5);
    // And they still count as runs, which is what makes the field necessary.
    expect(merged.score.runs).toBe(5);
    // No progress on any of them, so the split stays unmeasured rather than 0.
    expect(merged.score.avgProgress).toBeUndefined();
  });
});
