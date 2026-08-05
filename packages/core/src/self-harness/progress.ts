import type { ILoopEvent } from "../loop";

/**
 * How far a run got, as a number in [0, 1] — the graded signal the pass bit
 * cannot see.
 *
 * WHY THIS EXISTS: measured on a real failed `query` run, the gate went
 * 50 → 54 → 51 → 49 → 42 → 29 → 1 errors and stopped. It resolved 49 of 50 and
 * scored exactly the same as a run that resolved none, because the only thing
 * recorded was `passed: false`. Under that scoring an improvement has to flip a
 * whole task from red to green to be visible at all — and on a corpus where the
 * one failing task flips 60/40 by itself, nothing but a fluke ever clears the
 * bar. Every edit the loop accepted on 2026-08-04 was such a fluke.
 *
 * A fraction-of-errors-resolved is comparable across tasks (each normalised by
 * its own starting red) and is not gameable while the gate itself stays outside
 * the editable surface — which it does.
 */

/** One task's error counts within a run, oldest first. */
export interface ITaskTrace {
  readonly task: string;
  readonly counts: readonly number[];
}

/**
 * Gate error counts grouped BY TASK.
 *
 * Grouping is the whole point. A spec has several tasks, and taking one
 * minimum across the flat stream scored a failed run 1.0 whenever any single
 * task reached zero — indistinguishable from a pass, with the residual errors
 * of every later task ignored.
 */
export function taskTraces(events: readonly ILoopEvent[]): ITaskTrace[] {
  const byTask = new Map<string, number[]>();

  for (const e of events) {
    // `red` opens a task with its starting error count; `validated` reports
    // each gate settlement after that. Both carry `errors`.
    if (
      (e.kind !== "red" && e.kind !== "validated") ||
      e.errors === undefined
    ) {
      continue;
    }

    const counts = byTask.get(e.task) ?? [];

    counts.push(e.errors);
    byTask.set(e.task, counts);
  }

  return [...byTask].map(([task, counts]) => ({ task, counts }));
}

/** What one task achieved: the fraction of ITS starting errors it cleared.
 *
 *  The BEST state within that task, not its last — a task that reaches 1 error
 *  and thrashes back to 6 demonstrated it could reach 1, the harness keeps a
 *  near-green checkpoint for exactly that reason, and cycles already penalise
 *  the thrash. Scoped to the task so a neighbour's zero cannot leak in. */
function taskProgress(trace: ITaskTrace): number {
  const start = trace.counts[0];

  if (start === undefined || start <= 0) {
    // Opened green. Nothing was there to resolve, so this task contributes a
    // full share rather than dragging the mean toward zero.
    return 1;
  }

  return clamp01((start - Math.min(...trace.counts)) / start);
}

/**
 * A failed run can never score a full 1, however clean its gate got.
 *
 * Without this cap the original defect survives in a narrower form: a run whose
 * every task reached zero errors — type-clean and lint-clean — but which still
 * failed on behavioural acceptance scores exactly what a pass scores, and can
 * win the equal-pass-count tie-break against a candidate that genuinely passes.
 * Full credit is reserved for runs that actually went green.
 */
const FAILED_RUN_CEILING = 0.99;

/**
 * Fraction of its starting gate errors this run resolved.
 *
 * A pass is 1 by definition. A failure is the mean over its tasks, so a spec
 * whose first task greened and whose second is still deep in the red scores in
 * between — never 1.
 *
 * Every COMPLETED run gets a number, including one that produced no gate
 * readings at all: that scores 0. Returning undefined there was a gap a
 * candidate could walk through — turn a low-scoring failure into an unscored
 * one and the mean rises for free. Runs that never produced a result are
 * already tracked separately as `errored` and excluded upstream, so nothing
 * here has to represent infrastructure weather.
 */
export function runProgress(
  events: readonly ILoopEvent[],
  passed: boolean,
  taskIds: readonly string[]
): number {
  if (passed) {
    return 1;
  }

  // Only the spec's REAL tasks. run-spec also settles a whole-spec gate under
  // the pseudo-task `verify` once every task is green, and counting that as a
  // task inverted the measure: a single-task spec that GREENED its task and
  // then failed verify scored 0.5 (one full task over a denominator of two),
  // while a run still stuck at 1-of-10 errors mid-task scored 0.9. Getting
  // further scored worse — the same defect as early-quit, one step later.
  // Failing verify is already reflected by the run not passing, which the
  // ceiling below caps.
  const wanted = new Set(taskIds);
  const scored = taskTraces(events).filter((t) => wanted.has(t.task));

  if (scored.length === 0) {
    return 0;
  }

  // Denominator is every task the spec ASKED for, not the ones that opened.
  // Dividing by what was attempted rewarded giving up early: clearing task 1
  // and never opening task 2 beat clearing task 1 and part of task 2.
  const denominator = Math.max(taskIds.length, 1);
  const sum = scored.reduce((acc, t) => acc + taskProgress(t), 0);

  return Math.min(FAILED_RUN_CEILING, clamp01(sum / denominator));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

/**
 * Mean progress across a split's runs, or undefined when no run recorded one.
 *
 * Only runs that never produced a result lack a score — they are the `errored`
 * ones, which bypass scoring entirely — and those are SKIPPED rather than read
 * as zero: a dead endpoint is not a run that made no progress. Defaulting them
 * to 0 put infrastructure weather into the graded figure, so a split of nothing
 * but timeouts reported `avgProgress: 0` as though it had been measured.
 *
 * Every COMPLETED run always carries a number (see `runProgress`), so there is
 * no way for a candidate to drop an unflattering run out of the denominator.
 */
export function meanProgress(
  scores: readonly (number | undefined)[]
): number | undefined {
  const known = scores.filter((s): s is number => s !== undefined);

  if (known.length === 0) {
    return undefined;
  }

  return known.reduce((a, b) => a + b, 0) / known.length;
}
