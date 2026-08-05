import { test, expect, describe } from "bun:test";
import {
  errorTrace,
  runProgress,
  meanProgress,
} from "../src/self-harness/progress";
import type { ILoopEvent } from "../src/loop";

/**
 * The graded run score. Pass/fail could not distinguish a run that resolved 49
 * of 50 gate errors from one that resolved none, which is why the loop could
 * only ever accept flukes.
 */

function ev(kind: ILoopEvent["kind"], errors?: number, task = "1"): ILoopEvent {
  return {
    kind,
    task,
    message: "",
    ...(errors === undefined ? {} : { errors }),
  };
}

/** The real trace from a failed `query` run, 2026-08-05. */
const REAL_FAILED_RUN = [50, 54, 51, 49, 42, 42, 29, 1, 1, 1, 1, 1];

describe("errorTrace", () => {
  test("collects every gate reading, in order", () => {
    expect(
      errorTrace([ev("red", 8), ev("cycle"), ev("validated", 5), ev("token")])
    ).toEqual([8, 5]);
  });

  test("ignores events carrying no error count", () => {
    expect(errorTrace([ev("cycle"), ev("done"), ev("token")])).toEqual([]);
  });
});

describe("runProgress", () => {
  test("a pass is 1", () => {
    expect(runProgress([ev("red", 9)], true)).toBe(1);
  });

  test("the real failed run scores 0.98, not 0", () => {
    // THE point of this module. Under pass/fail this run and one that did
    // nothing are the same number.
    const events = REAL_FAILED_RUN.map((n, i) =>
      ev(i === 0 ? "red" : "validated", n)
    );

    expect(runProgress(events, false)).toBeCloseTo(0.98, 2);
  });

  test("reads the run as ONE series across tasks", () => {
    // gateSpec prefixes the same repo-wide gate to every task, so these are
    // successive snapshots of one global count. 20 → 10 during task 1 and
    // 10 → 5 during task 2 is 15 of 20 resolved. Averaging per task scored
    // this 0.5, which is not what happened.
    const events = [
      ev("red", 20, "1"),
      ev("validated", 10, "1"),
      ev("red", 10, "2"),
      ev("validated", 5, "2"),
    ];

    expect(runProgress(events, false)).toBeCloseTo(0.75, 5);
  });

  test("quitting early cannot outscore doing more work", () => {
    // Falls out of the series model: a run that stops after task 1 still ends
    // with task 2's errors on the board.
    const quitEarly = [ev("red", 20, "1"), ev("validated", 10, "1")];
    const didMore = [
      ev("red", 20, "1"),
      ev("validated", 10, "1"),
      ev("red", 10, "2"),
      ev("validated", 4, "2"),
    ];

    expect(runProgress(quitEarly, false)).toBeLessThan(
      runProgress(didMore, false)
    );
  });

  test("the whole-spec verify gate is just another reading", () => {
    // It used to be counted as an extra TASK, which inverted the score: a run
    // that greened its only task and then failed verify scored 0.5, below a
    // run still stuck mid-task.
    const events = [
      ev("red", 8, "1"),
      ev("validated", 0, "1"),
      ev("validated", 3, "verify"),
    ];

    expect(runProgress(events, false)).toBeCloseTo(0.625, 3);
  });

  test("a run that resolved nothing scores 0", () => {
    expect(runProgress([ev("red", 10), ev("validated", 10)], false)).toBe(0);
  });

  test("scores the state the run KEPT, not the best it passed through", () => {
    // 10 → 1 → 6 ends at 6, so it resolved 4 of 10. Crediting the transient 1
    // would score 0.9 for ground the run did not hold — and the near-green
    // checkpoint that once justified that is flag-gated and stops reverting
    // after MAX_NEAR_GREEN_ROLLBACKS.
    const events = [ev("red", 10), ev("validated", 1), ev("validated", 6)];

    expect(runProgress(events, false)).toBeCloseTo(0.4, 5);
  });

  test("a failed run whose gate went fully clean is still not a pass", () => {
    const events = [ev("red", 6), ev("validated", 0)];
    const score = runProgress(events, false);

    expect(score).toBeLessThan(1);
    expect(score).toBeCloseTo(0.99, 2);
  });

  test("getting worse than the start scores 0, never negative", () => {
    expect(runProgress([ev("red", 4), ev("validated", 20)], false)).toBe(0);
  });

  test("a run that opened clean and still failed scores 0", () => {
    // Failed for a reason that is not an error count — a timeout, a guard. There
    // is no graded claim to make beyond "not a pass", and 0/0 is not 100%.
    expect(runProgress([ev("red", 0), ev("stuck")], false)).toBe(0);
  });

  test("a completed run with no gate readings scores 0, not nothing", () => {
    // Returning undefined here was a hole: a candidate could turn a
    // low-scoring failure into an UNSCORED one and lift the mean for free.
    expect(runProgress([ev("cycle"), ev("stuck")], false)).toBe(0);
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
