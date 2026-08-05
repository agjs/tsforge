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
 * TWO READINGS OF ONE FIXED COMMAND. The score is the repo-wide gate, run once
 * before the model starts and once after it stops. That is the whole design, and
 * it is the third attempt at it: the first two derived the score from the gate
 * readings already in the event stream, and those readings are not comparable to
 * each other. `gateSpec` composes each task's acceptance onto the gate, so a
 * reading taken during task 1 measures a different command than one taken during
 * task 2 or at the whole-spec verify. A run that stopped after an easy task
 * ended on a narrow check and outscored a run that reached a broad, failure-heavy
 * one — not because it left the repo better, but because it was measured against
 * less. Every fix for that (group by task, whitelist ids, pick a denominator)
 * was a way of guessing at what a reading meant. Measuring the same command at
 * both ends means never having to guess: the two numbers are the same
 * quantity, so their difference is a fact about the run rather than about where
 * it happened to stop.
 */

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
 * Fraction of the gate errors the run started with that it had resolved when it
 * stopped, shrunk so clearing a handful is not worth what clearing fifty is.
 *
 * Both counts come from the SAME command (see the module note), so this is a
 * like-for-like difference. It scores the state the run KEPT: a trajectory that
 * dips to near-green and rebounds gets credit for where it ended, because the
 * near-green checkpoint that might have restored it is flag-gated and stops
 * reverting after MAX_NEAR_GREEN_ROLLBACKS.
 *
 * Every COMPLETED run gets a number, including one that opened on a clean gate:
 * that scores 0, since there is no graded claim to make about a failure that was
 * never about error counts. Returning undefined anywhere here would be a gap a
 * candidate could walk through — turn a low-scoring failure into an unscored one
 * and the mean rises for free. Runs that never produced a result are tracked
 * separately as `errored` and excluded upstream, so nothing here has to
 * represent infrastructure weather.
 */
export function runProgress(
  startErrors: number,
  endErrors: number,
  passed: boolean
): number {
  if (passed) {
    return 1;
  }

  if (!Number.isFinite(startErrors) || startErrors <= 0) {
    return 0;
  }

  const end = Number.isFinite(endErrors) ? Math.max(0, endErrors) : startErrors;
  const resolved = Math.max(0, startErrors - end);

  return Math.min(
    FAILED_RUN_CEILING,
    clamp01(resolved / (startErrors + PROGRESS_SHRINKAGE))
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
