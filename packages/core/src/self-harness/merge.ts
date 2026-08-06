import { meanProgress } from "./progress";
import type { IEvaluateOutcome } from "./evaluate";
import type { ISplitScore } from "./self-harness.types";

/** Mean over values that carry a signal (> 0); 0 when none do — the same
 *  convention evaluateHarness uses for quality and concision. */
function meanOfSignaled(values: readonly number[]): number {
  const signaled = values.filter((v) => v > 0);

  return signaled.length === 0
    ? 0
    : signaled.reduce((a, b) => a + b, 0) / signaled.length;
}

/** Merge single-task outcomes into one split outcome. Counts sum; the
 *  quality/concision means recompute over tasks that carry a signal —
 *  identical semantics to evaluateHarness's own aggregation. */
export function mergeOutcomes(
  outcomes: readonly IEvaluateOutcome[]
): IEvaluateOutcome {
  const records = outcomes.flatMap((o) => [...o.records]);
  const runs = outcomes.flatMap((o) => [...o.runs]);
  const perTask: ISplitScore["perTask"] = {};

  for (const outcome of outcomes) {
    for (const [task, summary] of Object.entries(outcome.score.perTask)) {
      perTask[task] = summary;
    }
  }

  return {
    records,
    runs,
    score: {
      passed: outcomes.reduce((a, o) => a + o.score.passed, 0),
      runs: outcomes.reduce((a, o) => a + o.score.runs, 0),
      errored: outcomes.reduce((a, o) => a + o.score.errored, 0),
      avgQuality: meanOfSignaled(outcomes.map((o) => o.score.avgQuality)),
      avgLoc: meanOfSignaled(outcomes.map((o) => o.score.avgLoc)),
      // Recomputed over RUNS, not averaged over outcomes: each outcome here is
      // one task, and a task measured twice must weigh twice — averaging the
      // per-task means would give a 1-run task the same weight as a 4-run one.
      //
      // Omitting this field is what made the graded score inert. Every real
      // session merges through here (the task-by-task path exists so one
      // endpoint flap costs one task, not the whole split), so `avgProgress`
      // was computed per task and then dropped before the acceptance rule saw
      // it — arriving undefined, failing closed, and rejecting every
      // equal-pass candidate with "progress was not measured".
      avgProgress: meanProgress(records.map((r) => r.progress)),
      perTask,
    },
  };
}
