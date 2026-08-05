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
 * A fraction-of-errors-resolved is comparable across tasks (each is normalised
 * by its own starting red), has real resolution per run, and is not gameable
 * while the gate itself stays outside the editable surface — which it does.
 */

/** Gate error counts over the life of a run, oldest first. */
export function errorTrace(events: readonly ILoopEvent[]): number[] {
  const counts: number[] = [];

  for (const e of events) {
    // `red` opens the run with the starting error count; `validated` reports
    // each gate settlement after that. Both carry `errors`.
    if (
      (e.kind === "red" || e.kind === "validated") &&
      e.errors !== undefined
    ) {
      counts.push(e.errors);
    }
  }

  return counts;
}

/**
 * Fraction of the starting errors this run resolved.
 *
 * A pass is 1 by definition. A failure is scored on what it cleared, using the
 * BEST state it reached rather than its last one: a run that reaches 1 error and
 * then thrashes back to 6 demonstrated it could get to 1, and the harness keeps
 * a near-green checkpoint for exactly that reason. Using the final count would
 * punish the thrash twice, since cycles already do.
 *
 * Returns undefined when the run recorded no gate settlements at all — an
 * infrastructure failure, not progress of zero. Scoring that as 0 would let a
 * dead endpoint drag a candidate's score down and look like a regression.
 */
export function runProgress(
  events: readonly ILoopEvent[],
  passed: boolean
): number | undefined {
  if (passed) {
    return 1;
  }

  const counts = errorTrace(events);
  const start = counts[0];

  if (start === undefined) {
    return undefined;
  }

  if (start === 0) {
    // Started green and still failed: the failure is not about error count
    // (a timeout, a guard, a non-gate block). No graded claim to make.
    return undefined;
  }

  const best = Math.min(...counts);

  return clamp01((start - best) / start);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

/** Mean progress over the runs that recorded one. Runs without a score are
 *  skipped rather than counted as zero, for the reason above. */
export function meanProgress(
  scores: readonly (number | undefined)[]
): number | undefined {
  const known = scores.filter((s): s is number => s !== undefined);

  if (known.length === 0) {
    return undefined;
  }

  return known.reduce((a, b) => a + b, 0) / known.length;
}
