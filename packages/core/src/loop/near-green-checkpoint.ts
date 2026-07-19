import type { IErrorItem } from "../validate/validate.types";

/** WS-B — near-green checkpoint / rollback-on-regression.
 *
 *  Bucket 2 of the failure taxonomy: the build reaches ~1 error, then SPRAYS back up
 *  (Phase 0a: e.g. inv157 `1 → 8`, all model-authored stack-pack violations) and thrashes
 *  for dozens of turns, never locking its best state. The escalation ladder can't help —
 *  the model keeps making NEW edits that regress. The fix is a cheap safety net: when the
 *  build is near green, SNAPSHOT the scope files; if the next gate sprays past that best,
 *  REVERT to it instead of letting the model build on the regression, and steer it to make
 *  a targeted fix from the near-green state.
 *
 *  These pure predicates own the checkpoint/rollback DECISION so it is unit-locked away
 *  from the Session's file I/O and gate side effects. Thresholds N (near-green ceiling) and
 *  M (spray delta) come from Phase 0a's real-log analysis: damaging near-green sprays
 *  cluster at prev∈{1,2}, jump≥4; benign wobble is jump≤1. N=2, M=3 cleanly separates them
 *  (catches 1→8, 2→6, 2→30; rejects 0→1, 1→2). A rollback is a REVERT, not a failed
 *  attempt — the caller must NOT advance the steer ladder or reset the block fingerprint. */

/** Default near-green ceiling: only error counts at or below this are "near green" and
 *  worth checkpointing (Phase 0a). */
export const NEAR_GREEN_N = 2;

/** Default spray delta: a regression only rolls back when it jumps MORE than this beyond
 *  the checkpoint (Phase 0a — benign wobble is +1, damaging sprays are +4 and up). */
export const NEAR_GREEN_M = 3;

/** A captured near-green state: the on-disk file contents and the gate errors open at
 *  the moment it was the all-time best. */
export interface INearGreenCheckpoint {
  readonly errorCount: number;
  readonly files: ReadonlyMap<string, string>;
  readonly errors: readonly IErrorItem[];
}

/** Whether a fresh gate result should be CHECKPOINTED: it's a new all-time low, it's near
 *  green (1..N), and not zero (zero means the build just went green — nothing to protect).
 *  `isNewLow` is the loop's own genuine-progress signal (a new all-time-low error count),
 *  passed in so this stays pure. */
export function shouldCheckpoint(
  curr: number,
  isNewLow: boolean,
  n: number = NEAR_GREEN_N
): boolean {
  return isNewLow && curr >= 1 && curr <= n;
}

/** Whether the current gate result is a SPRAY that should roll back to `checkpoint`: a
 *  checkpoint exists, it was near green (≤ N), and the current count jumped MORE than M
 *  beyond it. */
export function shouldRollback(
  checkpoint: INearGreenCheckpoint | undefined,
  curr: number,
  n: number = NEAR_GREEN_N,
  m: number = NEAR_GREEN_M
): boolean {
  if (checkpoint === undefined) {
    return false;
  }

  return checkpoint.errorCount <= n && curr > checkpoint.errorCount + m;
}
