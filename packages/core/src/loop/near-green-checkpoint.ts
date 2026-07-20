import type { IErrorItem } from "../validate/validate.types";
import type { IFileSnapshot } from "./file-snapshot";

/** WS-B — near-green checkpoint / rollback-on-regression.
 *
 *  Bucket 2 of the failure taxonomy: the build reaches ~1 error, then SPRAYS back up
 *  (Phase 0a: e.g. inv157 `1 → 8`, all model-authored stack-pack violations) and thrashes
 *  for dozens of turns, never locking its best. The escalation ladder can't help — the
 *  model keeps making NEW edits that regress. The fix is a cheap safety net: when the build
 *  is near green, SNAPSHOT the scope files; if the next gate sprays past that best, REVERT
 *  to it instead of letting the model build on the regression, and steer a targeted fix.
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

/** Cap on TOTAL reverts WS-B performs per drive before it stops (reverting AND
 *  checkpointing) and hands the stall to the escalation ladder. A per-drive total (reset in
 *  driveInner), not per-checkpoint — so a model that sprays → reverts → re-settles → sprays
 *  can't thrash to maxTurns by earning a fresh budget each re-arm. */
export const MAX_NEAR_GREEN_ROLLBACKS = 3;

/** A captured near-green state. Uses the shared IFileSnapshot substrate so a rollback
 *  rewrites edited files AND tombstones files the spray CREATED (helpers/tests/binaries) —
 *  a plain content map would leave those on disk and keep the gate sprayed. */
export interface INearGreenCheckpoint {
  readonly errorCount: number;
  readonly errors: readonly IErrorItem[];
  readonly snapshot: IFileSnapshot;
  /** The change-scoping `ctx.tool.touched` set at checkpoint time. Restored on rollback so
   *  change-scoped meta-rules (e.g. test-sibling-required) see the SAME touched files as at
   *  the checkpoint — else a file first edited during the spray stays "touched" after its
   *  contents revert, and the restored gate diverges from the checkpoint's errors. */
  readonly touched: ReadonlySet<string>;
  /** Raw bytes of the out-of-scope dependency files (package.json + lockfiles) at checkpoint
   *  time. These are a FIXED, tiny set (see ROLLBACK_EXTRA_FILES) that the shared text/tombstone
   *  snapshot can't faithfully restore (binary lockfiles), so WS-B captures them itself as raw
   *  bytes and rewrites them on rollback — no generic raw-backing / memory caps on the shared
   *  substrate needed, because this set is bounded and small. */
  readonly depFiles: ReadonlyMap<string, Uint8Array>;
}

/** Gate errors that in THIS stack clear ONLY by ADDING code — wiring the i18n keys the feature
 *  declared (`i18n-locale-keys-used`; the i18n-destructive-delete guard forbids the removal
 *  shortcut, so the model MUST add the UI that references them), or making the feature reachable
 *  (`reachability`; add the route/mount). A near-green state whose remaining errors are all of
 *  this class is a HOLLOW state (e.g. a list-only page with unused create/edit/delete
 *  translations): reaching green REQUIRES the model to add the form + buttons + toasts, which
 *  transiently spikes the error count. WS-B's count-only spray detection can't tell that
 *  legitimate completion edit from a bad convention spray, so checkpointing this state and
 *  reverting to it traps the model in the hollow app. NOTE: `judge` is deliberately EXCLUDED —
 *  the quality judge can reject defects in EXISTING code (fixable in place), not only
 *  hollowness, so it is not a reliable add-only signal. */
const COMPLETION_CLASS_RULES: ReadonlySet<string> = new Set([
  "reachability",
  "i18n-locale-keys-used",
]);

/** Whether a gate error clears only by adding code (see COMPLETION_CLASS_RULES). Matches the
 *  bare rule id so a plugin-prefixed form (`plugin/i18n-locale-keys-used`) still classifies. */
export function isCompletionClass(error: IErrorItem): boolean {
  const rule = error.rule ?? "";
  const bare = rule.split("/").pop() ?? rule;

  return COMPLETION_CLASS_RULES.has(bare);
}

/** True when EVERY remaining gate error is completion-class — the hollow near-green state WS-B
 *  must not protect. Empty is false (green is handled elsewhere; nothing to classify). */
export function allCompletionClass(errors: readonly IErrorItem[]): boolean {
  return errors.length > 0 && errors.every(isCompletionClass);
}

/** Advance the persistent completion-phase flag. ENTER when every error is completion-class (a
 *  hollow state); STAY while ANY completion error remains (the MIXED spike as the model wires
 *  the keys — a per-cycle all-completion check would flip false here and re-arm the rollback +
 *  "undo" banner mid-add); EXIT when no completion error remains (the model finished wiring →
 *  only fixable errors left → WS-B re-engages) or when green (no errors). */
export function nextCompletionPhase(
  prev: boolean,
  errors: readonly IErrorItem[]
): boolean {
  if (allCompletionClass(errors)) {
    return true;
  }

  if (!errors.some(isCompletionClass)) {
    return false;
  }

  return prev;
}

/** Whether a fresh gate result should be CHECKPOINTED: it's a new all-time low, it's near
 *  green (1..N), and not zero (zero means the build just went green — nothing to protect).
 *  `isNewLow` is the loop's own genuine-progress signal, passed in so this stays pure. */
export function shouldCheckpoint(
  curr: number,
  isNewLow: boolean,
  n: number = NEAR_GREEN_N
): boolean {
  return isNewLow && curr >= 1 && curr <= n;
}

/** Whether the current gate result is a SPRAY that should roll back to `checkpoint`. A spray
 *  is purely a COUNT jump of MORE than M beyond a near-green checkpoint — no phase heuristic
 *  (builder-model verdict + panel: phase-tagging conflated origin with regression and let a
 *  mostly-unphased spray masquerade as "frontier progress" and survive; count is monotonic
 *  under regression, so it catches every spray). It does NOT roll back when `rollbacks` has
 *  hit the cap (give up; let the ladder park the staller). The one accepted trade: if the
 *  model legitimately opens new work right at near-green, its first cycle can be reverted —
 *  bounded by the revert budget, and re-established on the next low. Never MISSING a spray is
 *  the correct bias for a near-green safety net. */
export function shouldRollback(
  checkpoint: INearGreenCheckpoint | undefined,
  curr: number,
  rollbacks: number,
  n: number = NEAR_GREEN_N,
  m: number = NEAR_GREEN_M
): boolean {
  if (checkpoint === undefined) {
    return false;
  }

  if (rollbacks >= MAX_NEAR_GREEN_ROLLBACKS) {
    return false;
  }

  return checkpoint.errorCount <= n && curr > checkpoint.errorCount + m;
}
