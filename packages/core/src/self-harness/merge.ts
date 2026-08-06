import { splitScore } from "./evaluate";
import type { IEvaluateOutcome } from "./evaluate";

/**
 * Merge single-task outcomes into one split outcome.
 *
 * Derived from the RECORDS, through the same `splitScore` the evaluator uses —
 * not rebuilt from the per-outcome scores. That rebuild is the whole reason this
 * PR exists: it listed the fields by hand, `avgProgress` was added to the
 * evaluator and forgotten here, and the graded dimension never reached the
 * acceptance rule for a week while every test passed. Two ways to construct one
 * type is the defect; patching the field that happened to be dropped would have
 * left the next one waiting.
 *
 * Only `errored` still sums across outcomes, and NOT for the reason I first
 * wrote here. An errored run does produce a record — `runOneSpec` pushes a
 * placeholder on its catch path, so it is counted in `runs` like any other. What
 * that record lacks is any field saying it errored: it looks exactly like a run
 * that failed honestly. So the count cannot be recovered from the records and
 * has to be carried alongside them.
 *
 * Duplicate task entries now MERGE rather than overwrite: `summarize` groups by
 * label, so two outcomes for one task become a single summary with the right run
 * count. The old merge kept whichever came last beside a total that counted
 * both, which made `perTask.avgCycles` — read by the acceptance rule's blowup
 * guard — describe a fraction of the runs it was compared against.
 */
export function mergeOutcomes(
  outcomes: readonly IEvaluateOutcome[]
): IEvaluateOutcome {
  const records = outcomes.flatMap((o) => [...o.records]);
  const runs = outcomes.flatMap((o) => [...o.runs]);
  const errored = outcomes.reduce((a, o) => a + o.score.errored, 0);

  return { records, runs, score: splitScore(records, errored) };
}
