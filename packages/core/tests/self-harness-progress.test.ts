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

function ev(kind: ILoopEvent["kind"], errors?: number): ILoopEvent {
  return {
    kind,
    task: "t",
    message: "",
    ...(errors === undefined ? {} : { errors }),
  };
}

/** The real trace from a failed `query` run, 2026-08-05. */
const REAL_FAILED_RUN = [50, 54, 51, 49, 42, 42, 29, 1, 1, 1, 1, 1];

describe("errorTrace", () => {
  test("collects the opening red and every gate settlement", () => {
    const events = [
      ev("red", 8),
      ev("cycle"),
      ev("validated", 5),
      ev("token"),
      ev("validated", 2),
    ];

    expect(errorTrace(events)).toEqual([8, 5, 2]);
  });

  test("ignores events with no error count", () => {
    expect(errorTrace([ev("cycle"), ev("done"), ev("token")])).toEqual([]);
  });
});

describe("runProgress", () => {
  test("a pass is 1", () => {
    expect(runProgress([ev("red", 9)], true)).toBe(1);
  });

  test("the real failed run scores 0.98, not 0", () => {
    // THE point of this module. Under pass/fail this run and a run that did
    // nothing are the same number.
    const events = REAL_FAILED_RUN.map((n, i) =>
      ev(i === 0 ? "red" : "validated", n)
    );

    expect(runProgress(events, false)).toBeCloseTo(0.98, 2);
  });

  test("a run that resolved nothing scores 0", () => {
    const events = [ev("red", 10), ev("validated", 10)];

    expect(runProgress(events, false)).toBe(0);
  });

  test("scores the BEST state reached, not the last", () => {
    // A run that reaches 1 error then thrashes back to 6 proved it could reach
    // 1; the harness keeps a near-green checkpoint for that reason, and cycles
    // already penalise the thrash.
    const events = [ev("red", 10), ev("validated", 1), ev("validated", 6)];

    expect(runProgress(events, false)).toBeCloseTo(0.9, 5);
  });

  test("getting WORSE than the start still scores 0, never negative", () => {
    const events = [ev("red", 4), ev("validated", 20)];

    expect(runProgress(events, false)).toBe(0);
  });

  test("a run with no gate settlements has no score", () => {
    // An endpoint failure. Scoring it 0 would let an outage read as a
    // regression and drag a candidate down for infrastructure weather.
    expect(runProgress([ev("cycle"), ev("stuck")], false)).toBeUndefined();
  });

  test("a failure that started green has no graded claim", () => {
    // Failed for a non-gate reason (timeout, guard). 0/0 is not 100%.
    expect(runProgress([ev("red", 0), ev("stuck")], false)).toBeUndefined();
  });
});

describe("meanProgress", () => {
  test("averages the runs that recorded a score", () => {
    expect(meanProgress([1, 0.5])).toBeCloseTo(0.75, 5);
  });

  test("skips unscored runs rather than counting them as zero", () => {
    // Two clean runs at 1.0 and one errored run must average 1.0, not 0.67.
    expect(meanProgress([1, undefined, 1])).toBe(1);
  });

  test("all-unscored yields undefined, not zero", () => {
    expect(meanProgress([undefined, undefined])).toBeUndefined();
  });

  test("an empty split yields undefined", () => {
    expect(meanProgress([])).toBeUndefined();
  });
});
