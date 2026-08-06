import { test, expect, describe } from "bun:test";
import { splitScore } from "../src/self-harness/evaluate";
import type { IRunRecord } from "../src/eval";

/**
 * The ONE place ISplitScore is assembled — tested where it lives, not only
 * through `mergeOutcomes`.
 *
 * It used to be built twice, in the evaluator and again in the merge, and that
 * second construction is what dropped `avgProgress` for a week. Reaching this
 * function only through the merge would repeat the shape of the original gap in
 * miniature: a change to its contract that the merge happens to tolerate would
 * go unnoticed here.
 */

const run = (
  label: string,
  passed: boolean,
  over: Partial<IRunRecord> = {}
): IRunRecord => ({
  label,
  passed,
  cycles: 1,
  ms: 0,
  progress: passed ? 1 : 0,
  ...over,
});

describe("splitScore", () => {
  test("counts passes and runs from the records themselves", () => {
    const score = splitScore(
      [run("a", true), run("b", false), run("c", true)],
      0
    );

    expect(score.passed).toBe(2);
    expect(score.runs).toBe(3);
  });

  test("errored is carried, not derived", () => {
    // The placeholder a failed attempt leaves behind is indistinguishable from
    // an honest failure, so the count has to be passed in.
    expect(splitScore([run("a", false)], 4).errored).toBe(4);
  });

  test("avgProgress is a mean over RUNS", () => {
    const score = splitScore(
      [
        run("a", false, { progress: 0 }),
        run("a", false, { progress: 0 }),
        run("b", false, { progress: 1 }),
      ],
      0
    );

    // Task-weighted would be 0.5; run-weighted is 1/3, and run-weighted is what
    // the acceptance rule compares.
    expect(score.avgProgress).toBeCloseTo(1 / 3, 5);
  });

  test("a record with no progress is skipped, not counted as zero", () => {
    const score = splitScore(
      [
        run("a", false, { progress: 0.6 }),
        { label: "b", passed: false, cycles: 0, ms: 0 },
      ],
      1
    );

    expect(score.avgProgress).toBeCloseTo(0.6, 5);
  });

  test("nothing scored leaves the split unmeasured", () => {
    const score = splitScore(
      [{ label: "a", passed: false, cycles: 0, ms: 0 }],
      1
    );

    expect(score.avgProgress).toBeUndefined();
  });

  test("quality and loc are averaged over TASKS that carry a signal", () => {
    const score = splitScore(
      [
        run("a", true, { quality: 4, loc: 100 }),
        run("b", true),
        run("c", true, { quality: 2, loc: 50 }),
      ],
      0
    );

    expect(score.avgQuality).toBeCloseTo(3, 5);
    expect(score.avgLoc).toBeCloseTo(75, 5);
  });

  test("perTask groups repeats of one task into a single summary", () => {
    const score = splitScore(
      [run("a", true, { cycles: 2 }), run("a", true, { cycles: 8 })],
      0
    );

    expect(Object.keys(score.perTask)).toEqual(["a"]);
    expect(score.perTask.a?.runs).toBe(2);
    expect(score.perTask.a?.avgCycles).toBe(5);
  });
});
