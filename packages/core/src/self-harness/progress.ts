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
  passed: boolean
): number {
  if (passed) {
    return 1;
  }

  const traces = taskTraces(events);

  if (traces.length === 0) {
    return 0;
  }

  const scores = traces.map((t) => taskProgress(t));

  return clamp01(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

/** Mean progress across a split's runs, or undefined when the split had no runs
 *  at all. Every run counts: there is no way to remove an unflattering run from
 *  the denominator. */
export function meanProgress(scores: readonly number[]): number | undefined {
  if (scores.length === 0) {
    return undefined;
  }

  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
