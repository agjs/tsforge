import { test, expect, describe } from "bun:test";
import {
  taskTraces,
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

describe("taskTraces", () => {
  test("groups counts by task", () => {
    const traces = taskTraces([
      ev("red", 8, "1"),
      ev("validated", 5, "1"),
      ev("red", 4, "2"),
      ev("validated", 4, "2"),
    ]);

    expect(traces).toEqual([
      { task: "1", counts: [8, 5] },
      { task: "2", counts: [4, 4] },
    ]);
  });

  test("ignores events carrying no error count", () => {
    expect(taskTraces([ev("cycle"), ev("done"), ev("token")])).toEqual([]);
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

  test("a failed multi-task run is NOT 1 just because one task greened", () => {
    // The bug the reviewers caught: one `Math.min` over the flat stream saw the
    // greened task's zero and scored the whole failed run 1.0 — identical to a
    // pass, with the second task's residual errors invisible.
    const events = [
      ev("red", 10, "1"),
      ev("validated", 0, "1"),
      ev("red", 10, "2"),
      ev("validated", 8, "2"),
    ];

    // task 1 resolved everything (1.0), task 2 resolved a fifth (0.2).
    expect(runProgress(events, false)).toBeCloseTo(0.6, 5);
  });

  test("a neighbouring task's zero cannot rescue a task that moved nothing", () => {
    const events = [
      ev("red", 5, "1"),
      ev("validated", 0, "1"),
      ev("red", 5, "2"),
      ev("validated", 5, "2"),
    ];

    expect(runProgress(events, false)).toBeCloseTo(0.5, 5);
  });

  test("a run that resolved nothing scores 0", () => {
    expect(runProgress([ev("red", 10), ev("validated", 10)], false)).toBe(0);
  });

  test("scores the best state reached WITHIN a task, not its last", () => {
    // A run that touches 1 error then thrashes back to 6 proved it could reach
    // 1; the harness keeps a near-green checkpoint for that reason and cycles
    // already penalise the thrash.
    const events = [ev("red", 10), ev("validated", 1), ev("validated", 6)];

    expect(runProgress(events, false)).toBeCloseTo(0.9, 5);
  });

  test("getting worse than the start scores 0, never negative", () => {
    expect(runProgress([ev("red", 4), ev("validated", 20)], false)).toBe(0);
  });

  test("a completed run with no gate readings scores 0, not nothing", () => {
    // Returning undefined here was a hole: a candidate could turn a
    // low-scoring failure into an UNSCORED one and lift the mean for free.
    // Genuine infrastructure failures are tracked as `errored` and excluded
    // upstream, so this path does not need to represent them.
    expect(runProgress([ev("cycle"), ev("stuck")], false)).toBe(0);
  });

  test("a task that opened green contributes a full share", () => {
    // Nothing was there to resolve; it must not drag the mean toward zero.
    const events = [
      ev("red", 0, "1"),
      ev("red", 4, "2"),
      ev("validated", 2, "2"),
    ];

    expect(runProgress(events, false)).toBeCloseTo(0.75, 5);
  });
});

describe("meanProgress", () => {
  test("averages every run", () => {
    expect(meanProgress([1, 0.5])).toBeCloseTo(0.75, 5);
  });

  test("no run can be removed from the denominator", () => {
    // Three runs, one of them zero: the mean is 0.67, not 1.0. There is no
    // longer any way to drop an unflattering run.
    expect(meanProgress([1, 0, 1])).toBeCloseTo(0.6667, 3);
  });

  test("an empty split yields undefined", () => {
    expect(meanProgress([])).toBeUndefined();
  });
});
