import { test, expect, describe } from "bun:test";
import { runProgress, meanProgress } from "../src/self-harness/progress";

/**
 * The graded run score. Pass/fail could not distinguish a run that resolved 49
 * of 50 gate errors from one that resolved none, which is why the loop could
 * only ever accept flukes.
 *
 * Two readings of ONE fixed command — the bare repo-wide gate, before the model
 * starts and after it stops. Earlier versions derived the score from the gate
 * readings already in the event stream, and those are not comparable: gateSpec
 * composes each task's acceptance onto the gate, so a reading during task 1
 * measures a different command than one during task 2 or at verify.
 */

describe("runProgress", () => {
  test("a pass is 1", () => {
    expect(runProgress(9, 0, true)).toBe(1);
  });

  test("the real failed run scores 0.89, not 0", () => {
    // THE point of this module. Under pass/fail this run and one that did
    // nothing are the same number.
    expect(runProgress(50, 1, false)).toBeCloseTo(49 / 55, 5);
  });

  test("a run that resolved nothing scores 0", () => {
    expect(runProgress(10, 10, false)).toBe(0);
  });

  test("clearing one error is not worth what clearing fifty is", () => {
    // Without shrinkage a 1 → 0 failure scored 0.99, so on a four-run split one
    // flaky lint moved avgProgress 25pp — five times the promotion floor — and
    // could carry an edit through by itself.
    const oneLint = runProgress(1, 0, false);
    const realWork = runProgress(50, 0, false);

    expect(oneLint).toBeCloseTo(1 / 6, 5);
    expect(realWork).toBeCloseTo(50 / 55, 5);
    expect(realWork).toBeGreaterThan(oneLint * 4);
  });

  test("a failed run whose gate went fully clean is still not a pass", () => {
    const score = runProgress(6, 0, false);

    expect(score).toBeLessThan(1);
    expect(score).toBeCloseTo(6 / 11, 5);
  });

  test("the ceiling holds even on a huge clean sweep", () => {
    // Shrinkage alone would let a large enough run round up and tie a genuine
    // pass in the equal-pass comparison.
    expect(runProgress(100_000, 0, false)).toBe(0.99);
  });

  test("getting worse than the start scores 0, never negative", () => {
    expect(runProgress(4, 20, false)).toBe(0);
  });

  test("a run that opened on a clean gate scores 0", () => {
    // Failed for a reason that is not an error count — a timeout, a guard.
    // There is no graded claim to make beyond "not a pass", and 0/0 is not 100%.
    expect(runProgress(0, 0, false)).toBe(0);
  });

  test("an unreadable end count is scored as no progress, not as a win", () => {
    // Fails toward zero credit: a measurement that did not happen must never
    // read as errors resolved.
    expect(runProgress(40, Number.NaN, false)).toBe(0);
  });

  test("scores the state the run KEPT, not the best it passed through", () => {
    // The end reading is taken after the run stops, so a trajectory that dipped
    // to near-green and rebounded is scored where it ended. The near-green
    // checkpoint that might have restored it is flag-gated and stops reverting
    // after MAX_NEAR_GREEN_ROLLBACKS.
    expect(runProgress(10, 6, false)).toBeCloseTo(4 / 15, 5);
  });
});

describe("meanProgress", () => {
  test("averages every run", () => {
    expect(meanProgress([1, 0.5])).toBeCloseTo(0.75, 5);
  });

  test("no COMPLETED run can be removed from the denominator", () => {
    // Three runs, one of them zero: the mean is 0.67, not 1.0. Every completed
    // run always carries a number, so none can be dropped.
    expect(meanProgress([1, 0, 1])).toBeCloseTo(0.6667, 3);
  });

  test("an errored run is skipped, not scored as zero progress", () => {
    // Errored runs never reach scoring and carry no figure. Reading them as 0
    // put infrastructure weather into the graded measure — a split of nothing
    // but timeouts reported 0% progress as though it had been measured.
    expect(meanProgress([1, undefined, 1])).toBe(1);
    expect(meanProgress([undefined, undefined])).toBeUndefined();
  });

  test("an empty split yields undefined", () => {
    expect(meanProgress([])).toBeUndefined();
  });
});
