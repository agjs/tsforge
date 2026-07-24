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
 *  shortcut, so the model MUST add the UI that references them), making the feature reachable
 *  (`reachability`; add the route/mount), or writing the required colocated test for a logic
 *  module (`logic-files-require-test-sibling`; every `*.{hooks,queries,mutations,store,schemas,
 *  service,utils}.ts` module the model adds demands a `.test.ts(x)` sibling — cleared ONLY by
 *  ADDING that test file). A near-green state whose remaining errors are all of this class is a
 *  HOLLOW/INCOMPLETE state (a list-only page with unused create/edit/delete translations, or fresh
 *  logic modules still awaiting their tests): reaching green REQUIRES the model to ADD the form +
 *  buttons + toasts + test siblings, which transiently spikes the error count. WS-B's count-only
 *  spray detection can't tell that legitimate completion work from a bad convention spray, so
 *  checkpointing this state and reverting to it TRAPS the model — it deletes the logic modules the
 *  model just added, so it can never accumulate the N tests it needs (live: build34/36 ground
 *  near-green reverting exactly this). NOTE: `judge` is deliberately EXCLUDED — the quality judge
 *  can reject defects in EXISTING code (fixable in place), not only hollowness, so it is not a
 *  reliable add-only signal. `logic-files-require-test-sibling` IS reliable: it has no fix-in-place
 *  form — the only non-destructive resolution is to add the test. */
const COMPLETION_CLASS_RULES: ReadonlySet<string> = new Set([
  "reachability",
  "i18n-locale-keys-used",
  "logic-files-require-test-sibling",
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

/** #77: near-green ROTATING-error oscillation. At near green the model can clear its single
 *  remaining error, but the FIX spawns a new one — e.g. it extracts a component, so that
 *  component's required sibling set + colocated tests are now missing; fixing those creates
 *  more, etc. The error COUNT stays low while the error SET rotates, so the build never reaches
 *  0 (build17 parked on this; build16 crossed the same tail by luck). Count-only WS-B can't see
 *  it (count never sprays past the checkpoint). The window of consecutive near-green cycles over
 *  which a CHANGING error-set signature counts as rotation rather than a one-off wobble. */
export const ROTATION_WINDOW = 3;

/** Max CONSECUTIVE spikes (cycles above the near-green ceiling) tolerated between two near-green
 *  samples before the rotation window is considered STALE and cleared. The rotating pattern is a
 *  tight fix-one → spray → revert → near-green loop, so real near-green visits sit a handful of
 *  cycles apart; without a bound, two near-green samples could survive an arbitrarily long
 *  regression and combine with a much later, unrelated near-green result to fire the steer
 *  falsely (a fresh near-green episode, not the same rotation). */
export const MAX_NEAR_GREEN_SPIKE_GAP = 3;

/** A stable, order- and line-independent per-error identity token for rotation detection. When the
 *  error has BOTH a `rule` and a `file` (the eslint/type-aware shape), use the `rule|file` FAMILY:
 *  the key carries the line (`file:line:rule`), so a re-emission at a shifted line must still read
 *  as the SAME error — the family form gives that. Otherwise (`rule` and/or `file` absent — both are
 *  OPTIONAL on IErrorItem; custom gates emit key-only errors) fall back to the required `key`: a
 *  PARTIAL family (`rule|` or `|file`) would collapse DISTINCT errors that merely share the one
 *  present field (their keys differ), hiding rotations among them — the key keeps them distinct. */
function errorToken(e: IErrorItem): string {
  return e.rule !== undefined && e.file !== undefined
    ? `${e.rule}|${e.file}`
    : e.key;
}

/** A stable, order- and line-independent signature of an error SET: the sorted unique per-error
 *  identity tokens (see errorToken). Re-emitting the SAME errors at shifted lines reads as
 *  unchanged; a genuinely different set reads as changed — which is what makes rotation detectable.
 *  Generic: keyed only on the stack-agnostic rule/file/key fields.
 *  DELIBERATE trade-off: the token DEDUPES by `rule|file` family and drops multiplicity, so a
 *  plateau rotating between two DISTINCT instances of the SAME rule in the SAME file (e.g. one
 *  `no-unsafe-call` in x.ts swapped for another `no-unsafe-call` in x.ts at count 1) reads as
 *  unchanged and is NOT detected. Distinguishing those needs the line (it's the only differing
 *  field), and the line is exactly what `autofixApps` (prettier/eslint --fix, run every cycle)
 *  reflows — so a line-sensitive signature would fire FALSE rotations on every autofix. Line-
 *  independence is the more important property: the observed failure (build17) rotates across
 *  DIFFERENT rules, which the family form detects. Same-rule-same-file instance rotation is
 *  knowingly left to the count-based WS-B checkpoint + escalation ladder. */
export function errorSetSignature(errors: readonly IErrorItem[]): string {
  return [...new Set(errors.map(errorToken))].sort().join(";");
}

/** One recorded near-green cycle: its error COUNT, the gate FRONTIER phase it sits at, the
 *  `errorSetSignature` of its error set, and `rev` — an INDEPENDENT worktree revision (a content
 *  hash of the scope files at gate time; see scopeRevision in turn.ts). Rotation is judged over a
 *  trailing window of these — the count + phase pin the PLATEAU (a stuck frontier at a stable
 *  count), the signature pins the changing IDENTITY, and `rev` proves a GENUINE per-cycle EDIT
 *  happened between two samples: without it, a flaky/stateful gate — or a re-evaluation of the SAME
 *  unedited files (e.g. the check-tool + settleGate double-run) — could emit A→B→C error signatures
 *  with no fix-one→spawn-another cycle at all and falsely stand the WS-B rollback net down. */
export interface INearGreenSample {
  readonly count: number;
  readonly phase: number;
  readonly sig: string;
  readonly rev: string;
}

/** Whether the recent near-green cycles are ROTATING. `samples` is the trailing list captured on
 *  cycles whose count was near green (the caller only records them there). Rotation requires BOTH:
 *   • a PLATEAU — the full window of `k` cycles sits at ONE error count AND ONE gate-frontier phase.
 *     build17's shape (and the 4/4 diagnosis) is "the count stays at best-ever (1) while the
 *     fingerprint rotates"; a window whose count MOVES (e.g. 2→1→1, a descent, or 1→2, a
 *     regression) is progress/regress, NOT rotation. A window whose PHASE moves is also progress:
 *     a short-circuiting composed gate reveals the next phase's errors only after the current
 *     phase clears, so A@phase1 → B@phase2 at the same count is genuine frontier advancement (the
 *     convergence logic counts it as progress), NOT rotation — firing the "don't open new
 *     routes/modules" steer there would fight exactly the downstream work that just became
 *     reachable. Requiring a constant phase excludes it. (When the gate sets no phase, all samples
 *     are phase 0 — constant — so this is a no-op there.)
 *   • GENUINE per-cycle rotation — on EVERY cycle of the window the signature CHANGES *and* the
 *     worktree `rev` CHANGES (no two CONSECUTIVE samples share a signature OR a rev). Requiring the
 *     rev to move is what makes the rotation genuine rather than merely apparent: a changing
 *     signature ALONE can come from a flaky/stateful gate or a re-evaluation of the SAME unedited
 *     files (A,B,C with rev held constant) — there was no fix-one→spawn-another edit, so it must NOT
 *     fire. Only a signature that rotates BECAUSE the model edited every cycle (rev moves in
 *     lock-step) is the build17 pattern. This is stricter than "≥2 distinct signatures in the
 *     window": A,A,B (one error merely replaced once, then stable) is NOT rotation, but A,B,C and
 *     the 2-cycle ring A,B,A both are (provided each carries a fresh rev). The strictness is
 *     deliberate and load-bearing: setting `nearGreenRotation` DISABLES the WS-B rollback safety net
 *     (nearGreenRollbackStep stands down so the steered atomic-completion spike isn't reverted).
 *     Firing on weak evidence (a single error-swap, or gate flake on unchanged files) would disable
 *     that net for a build that is merely progressing — so the detector must be CONFIDENT the
 *     frontier is actually cycling under real edits before it fires. A full window of ONE signature
 *     is a stuck single error (the ladder/expert own it), also not rotation.
 *  Only the last `k` matter, so a rotation that has since stabilized reads as not-rotating. */
export function isNearGreenRotation(
  samples: readonly INearGreenSample[],
  k: number = ROTATION_WINDOW
): boolean {
  if (samples.length < k) {
    return false;
  }

  const window = samples.slice(-k);
  const countPlateau = new Set(window.map((s) => s.count)).size === 1;
  const phasePlateau = new Set(window.map((s) => s.phase)).size === 1;

  if (!countPlateau || !phasePlateau) {
    return false;
  }

  // Genuine rotation: on every cycle BOTH the identity and the worktree rev must change (no two
  // consecutive equal). The sig-change is the rotating frontier; the rev-change proves a real
  // per-cycle EDIT drove it — so a flaky gate re-emitting different signatures over UNCHANGED files
  // (rev held constant) reads as not-rotating and leaves the WS-B rollback net engaged.
  return window.every((s, i) => {
    if (i === 0) {
      return true;
    }

    const prev = window[i - 1];

    return prev !== undefined && s.sig !== prev.sig && s.rev !== prev.rev;
  });
}
