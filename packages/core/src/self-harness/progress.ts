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
 * ONE SERIES, NOT PER TASK. `gateSpec` prefixes the same repo-wide gate command
 * to every task's accept, so each reading is a snapshot of one global error
 * count, not an independent task-local measure. An earlier version grouped by
 * task and averaged, which was a wrong model of the data and produced a bug for
 * every way of choosing a denominator: quitting early scored higher than doing
 * more work, the whole-spec `verify` pseudo-task inverted the score, and one
 * task reaching zero credited the entire run. Reading the run as the single
 * series it is removes all of them at once — 20 → 10 → 5 is 15 of 20 resolved,
 * which is simply what happened.
 */

/** Gate error counts over the run, oldest first. */
export function errorTrace(events: readonly ILoopEvent[]): number[] {
  const counts: number[] = [];

  for (const e of events) {
    // `red` opens a task with the current global error count; `validated`
    // reports each gate settlement. Both carry `errors`.
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
 * A failed run can never score a full 1, however clean its gate got.
 *
 * A run whose gate reached zero errors — type-clean and lint-clean — but which
 * still failed on behavioural acceptance would otherwise score exactly what a
 * pass scores, and could win the equal-pass tie-break against a candidate that
 * genuinely passes. Full credit is reserved for runs that actually went green.
 */
const FAILED_RUN_CEILING = 0.99;

/**
 * Added to the denominator so credit scales with the SIZE of what was cleared.
 *
 * A raw ratio makes small runs nearly binary: a run that opens on one error
 * scores 0.99 if it clears it and 0 if it does not. On a four-run split that
 * single lint is worth 25pp of `avgProgress` — five times the promotion floor —
 * so one flaky formatting error would carry an edit through on its own, which is
 * exactly the noise-acceptance this whole change exists to stop. It also made
 * clearing one lint look like clearing 49 of 50.
 *
 * With this, a 1 → 0 failure scores 1/6 and a 50 → 5 scores 45/55. The
 * shrinkage costs a large run almost nothing and costs a trivial one most of its
 * credit, which is the right order.
 */
const PROGRESS_SHRINKAGE = 5;

/**
 * Fraction of the run's starting gate errors that it resolved, shrunk so that
 * clearing a handful is not worth what clearing fifty is (`PROGRESS_SHRINKAGE`).
 *
 * A pass is 1 by definition. A failure is scored on the state it KEPT — first
 * reading against last — not the best it passed through. Crediting a transient
 * low would score 10 → 1 → 6 as 0.9 while it ended at 6; the near-green
 * checkpoint that once justified this is flag-gated and stops reverting after
 * MAX_NEAR_GREEN_ROLLBACKS, so a run is not guaranteed to end where it banked.
 * When the checkpoint does restore, the final reading IS the best one.
 *
 * Every COMPLETED run gets a number, including one that produced no gate
 * readings at all: that scores 0. Returning undefined there was a gap a
 * candidate could walk through — turn a low-scoring failure into an unscored
 * one and the mean rises for free. Runs that never produced a result are
 * tracked separately as `errored` and excluded upstream, so nothing here has to
 * represent infrastructure weather.
 */
export function runProgress(
  events: readonly ILoopEvent[],
  passed: boolean
): number {
  if (passed) {
    return 1;
  }

  const counts = errorTrace(events);
  const start = counts[0];
  const end = counts[counts.length - 1];

  if (start === undefined || end === undefined) {
    return 0;
  }

  if (start <= 0) {
    // Opened green and still failed — a timeout, a guard, something that is not
    // an error count. No graded claim to make beyond "not a pass".
    return 0;
  }

  const resolved = Math.max(0, start - end);

  return Math.min(
    FAILED_RUN_CEILING,
    clamp01(resolved / (start + PROGRESS_SHRINKAGE))
  );
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
