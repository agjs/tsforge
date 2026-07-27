import { test, expect } from "bun:test";
import {
  shouldCheckpoint,
  shouldRollback,
  isCompletionClass,
  allCompletionClass,
  nextCompletionPhase,
  errorSetSignature,
  isNearGreenRotation,
  ROTATION_WINDOW,
  NEAR_GREEN_N,
  NEAR_GREEN_M,
  MAX_NEAR_GREEN_ROLLBACKS,
  type INearGreenCheckpoint,
} from "../src/loop/near-green-checkpoint";
import type { IErrorItem } from "../src/validate/validate.types";
import type { IFileSnapshot } from "../src/loop/file-snapshot";

// #61: a HOLLOW near-green state (remaining errors clear only by ADDING code — i18n keys,
// reachability, judge) must NOT be checkpointed, or WS-B reverts the demanded completion edit.
const err = (rule: string): IErrorItem => ({ key: rule, rule, message: rule });

test("isCompletionClass: reliable add-code rules (reachability/i18n-locale-keys-used/test-sibling), bare or prefixed", () => {
  expect(isCompletionClass(err("reachability"))).toBe(true);
  expect(isCompletionClass(err("i18n-locale-keys-used"))).toBe(true);
  expect(isCompletionClass(err("plugin/i18n-locale-keys-used"))).toBe(true);
  // #61/#65: a missing colocated test clears ONLY by ADDING the test file — reliably add-only, so
  // WS-B must not revert the logic modules the model just added (build34/36 ground on this).
  expect(isCompletionClass(err("logic-files-require-test-sibling"))).toBe(true);
  // #61/panel: a missing required test-id or an unwired feature clears ONLY by ADDING the create/
  // edit/delete UI (a hollow list-only page) — reliably add-only, so WS-B must not revert the UI
  // the model just added (valbuild23 parked on testid-presence exactly this way).
  expect(isCompletionClass(err("testid-presence"))).toBe(true);
  expect(isCompletionClass(err("feature-wiring"))).toBe(true);
  // `judge` is EXCLUDED — it can reject defects in existing code, not only hollowness, so it
  // isn't a reliable add-only signal (would falsely disable WS-B on a fixable judge rejection).
  expect(isCompletionClass(err("judge"))).toBe(false);
  // Fixable-in-place errors are NOT completion-class (WS-B still protects against those).
  expect(isCompletionClass(err("no-floating-promises"))).toBe(false);
  expect(isCompletionClass(err("@typescript-eslint/no-unsafe-argument"))).toBe(
    false
  );
  expect(isCompletionClass({ key: "x", message: "no rule" })).toBe(false);
});

test("nextCompletionPhase: ENTER on all-completion, STAY through the mixed spike, EXIT when no completion error remains", () => {
  const i18n = err("i18n-locale-keys-used");
  const compile = err("no-unsafe-argument");

  // ENTER: reached the hollow all-completion state.
  expect(nextCompletionPhase(false, [i18n])).toBe(true);
  // STAY: the model started adding the UI → MIXED errors (this is the case a per-cycle
  // all-completion check got wrong — it would flip false here and re-arm rollback/undo).
  expect(nextCompletionPhase(true, [i18n, compile, compile])).toBe(true);
  // EXIT: the keys are now referenced → only fixable errors remain → WS-B re-engages.
  expect(nextCompletionPhase(true, [compile, compile])).toBe(false);
  // EXIT on green (no errors at all).
  expect(nextCompletionPhase(true, [])).toBe(false);
  // Never enters from a purely-fixable state.
  expect(nextCompletionPhase(false, [compile])).toBe(false);
});

test("allCompletionClass: true only when EVERY error is completion-class; empty is false", () => {
  expect(allCompletionClass([err("i18n-locale-keys-used")])).toBe(true);
  expect(
    allCompletionClass([err("reachability"), err("i18n-locale-keys-used")])
  ).toBe(true);
  // A single fixable error among completion ones means the state is NOT purely hollow —
  // WS-B should still protect it (the fixable error is a real revert target).
  expect(
    allCompletionClass([err("i18n-locale-keys-used"), err("no-console")])
  ).toBe(false);
  expect(allCompletionClass([])).toBe(false);
});

test("build34/36 spike (1 dead-locale-key + N missing-test siblings) is ALL completion-class → WS-B stands down", () => {
  // The exact live spike that trapped build34/36: fixing near-green, the model added logic modules
  // (each needs a test) + declared an i18n key not yet wired. All add-only → the count jump is
  // legitimate completion work, not a spray, so allCompletionClass is true (WS-B must NOT revert).
  const spike = [
    err("i18n-locale-keys-used"),
    err("logic-files-require-test-sibling"),
    err("logic-files-require-test-sibling"),
    err("logic-files-require-test-sibling"),
    err("logic-files-require-test-sibling"),
    err("logic-files-require-test-sibling"),
  ];

  expect(allCompletionClass(spike)).toBe(true);
  // ENTER the completion phase across the spike (WS-B rollback stood down so the added logic
  // modules + their pending tests are not reverted).
  expect(nextCompletionPhase(false, spike)).toBe(true);

  // Mechanism note (mirrors the i18n/reachability STAY-through-mixed semantics that already exist):
  // while ANY completion-class error still remains, the phase STAYS true even if a genuine fixable
  // regression (a broken test) is mixed in — a per-cycle re-arm would flip the rollback + undo
  // banner mid-add and re-trap the model. So the phase does NOT re-arm here…
  const mixed = [...spike, err("no-unsafe-argument")];

  expect(allCompletionClass(mixed)).toBe(false);
  expect(nextCompletionPhase(true, mixed)).toBe(true);
  // …and it correctly EXITS (re-arms WS-B) only once the completion work is DONE — no test-sibling
  // (or other add-only) error remains, leaving just the fixable regression to protect against.
  expect(nextCompletionPhase(true, [err("no-unsafe-argument")])).toBe(false);
  // Standing WS-B down does NOT relax the GATE: the final validate still runs every rule, so a
  // broken test can never reach green — the model must fix it (guided by the gate + the ladder).
});

// WS-B: the pure checkpoint/rollback decision, unit-locked with the Phase 0a thresholds
// (N=2, M=3) away from the Session's file I/O. Real spray data from inv157/inv156.

const emptySnapshot: IFileSnapshot = {
  cwd: "/x",
  scope: [],
  existed: new Set(),
  contents: new Map(),
};

/** A checkpoint at `errorCount`. */
function cp(errorCount: number): INearGreenCheckpoint {
  return {
    errorCount,
    errors: [],
    snapshot: emptySnapshot,
    touched: new Set(),
    depFiles: new Map(),
  };
}

test("defaults match Phase 0a (N=2, M=3) + a bounded revert budget", () => {
  expect(NEAR_GREEN_N).toBe(2);
  expect(NEAR_GREEN_M).toBe(3);
  expect(MAX_NEAR_GREEN_ROLLBACKS).toBeGreaterThanOrEqual(1);
});

test("shouldCheckpoint: a NEW LOW at 1..N is worth protecting; 0 and >N are not", () => {
  expect(shouldCheckpoint(1, true)).toBe(true);
  expect(shouldCheckpoint(2, true)).toBe(true);
  expect(shouldCheckpoint(0, true)).toBe(false); // green — nothing to protect
  expect(shouldCheckpoint(3, true)).toBe(false); // above the near-green ceiling
  expect(shouldCheckpoint(8, true)).toBe(false);
  expect(shouldCheckpoint(1, false)).toBe(false); // not a new low → never
});

test("shouldRollback: fires on a damaging near-green spray, not on benign wobble", () => {
  // Phase 0a damaging sprays (prev∈{1,2}, jump≥4) → roll back. (rollbacks 0.)
  expect(shouldRollback(cp(1), 8, 0)).toBe(true); // inv157 1→8 (+7)
  expect(shouldRollback(cp(2), 6, 0)).toBe(true); // 2→6 (+4)
  expect(shouldRollback(cp(2), 30, 0)).toBe(true); // 2→30 (+28)
  expect(shouldRollback(cp(1), 5, 0)).toBe(true); // 1→5 (+4) over the line
  // Benign wobble (jump ≤ M) → NO rollback.
  expect(shouldRollback(cp(1), 2, 0)).toBe(false); // 1→2 (+1)
  expect(shouldRollback(cp(2), 5, 0)).toBe(false); // 2→5 (+3, not > M)
  expect(shouldRollback(cp(1), 4, 0)).toBe(false); // 1→4 (+3, not > M)
});

test("shouldRollback: no checkpoint → never rolls back", () => {
  expect(shouldRollback(undefined, 99, 0)).toBe(false);
});

test("shouldRollback: a checkpoint above the near-green ceiling never rolls back", () => {
  expect(shouldRollback(cp(5), 59, 0)).toBe(false);
});

test("shouldRollback: spray detection is COUNT-only — no phase heuristic", () => {
  // The builder-model + panel verdict: phase-tagging let a mostly-unphased spray masquerade
  // as "frontier progress" and survive. Detection is now purely the count jump — a big jump
  // past a near-green checkpoint is ALWAYS a spray, regardless of any error's origin/phase.
  expect(shouldRollback(cp(1), 8, 0)).toBe(true);
  // A jump within M is still benign wobble, never a spray.
  expect(shouldRollback(cp(1), 3, 0)).toBe(false); // +2, not > M
});

test("shouldRollback: gives up after MAX_NEAR_GREEN_ROLLBACKS (bounds the revert loop)", () => {
  // Under the cap → still reverts.
  expect(shouldRollback(cp(1), 8, MAX_NEAR_GREEN_ROLLBACKS - 1)).toBe(true);
  // At/over the cap → stop reverting, let the escalation ladder park the staller.
  expect(shouldRollback(cp(1), 8, MAX_NEAR_GREEN_ROLLBACKS)).toBe(false);
});

test("thresholds are overridable (for config / A/B)", () => {
  expect(shouldCheckpoint(3, true, 4)).toBe(true); // wider ceiling
  expect(shouldRollback(cp(3), 7, 0, 4, 3)).toBe(true); // N=4,M=3 → 3→7 (+4)
  expect(shouldRollback(cp(1), 3, 0, 2, 1)).toBe(true); // M=1 → 1→3 (+2)
});

// #77: near-green ROTATING-error oscillation — the count stays ≤N but the SPECIFIC error set
// rotates (jsx-computation → missing-sibling → no-unsafe-call → …), so each single-error fix
// swaps for a new one and the build never reaches 0 (build17 parked here; build16 crossed by
// luck). The detector must tell rotation apart from a genuinely stuck single error.
const rerr = (rule: string, file: string): IErrorItem => ({
  key: `${file}:1:${rule}`,
  rule,
  file,
  message: rule,
});

test("errorSetSignature: order- and line-independent, deduped, keyed by rule|file", () => {
  // Order-independent.
  expect(
    errorSetSignature([rerr("no-unsafe-call", "x.ts"), rerr("jsx", "y.tsx")])
  ).toBe(
    errorSetSignature([rerr("jsx", "y.tsx"), rerr("no-unsafe-call", "x.ts")])
  );
  // Line-independent (the key's line moves as code shifts; the signature must not).
  expect(
    errorSetSignature([
      { key: "x.ts:9:r", rule: "r", file: "x.ts", message: "m" },
    ])
  ).toBe(
    errorSetSignature([
      { key: "x.ts:1:r", rule: "r", file: "x.ts", message: "m" },
    ])
  );
  // Deduped: two errors sharing rule|file collapse to one.
  expect(
    errorSetSignature([
      rerr("no-unsafe-call", "x.ts"),
      rerr("no-unsafe-call", "x.ts"),
    ])
  ).toBe(errorSetSignature([rerr("no-unsafe-call", "x.ts")]));
  // A DIFFERENT set has a different signature (so rotation is detectable).
  expect(errorSetSignature([rerr("jsx", "x.ts")])).not.toBe(
    errorSetSignature([rerr("no-unsafe-call", "x.ts")])
  );
  // rule AND file both absent (custom gates emit key-only errors): fall back to the required key
  // so distinct errors don't all collapse to "|" and hide rotation among them.
  expect(errorSetSignature([{ key: "a", message: "m" }])).not.toBe(
    errorSetSignature([{ key: "b", message: "m" }])
  );
  // PARTIAL family — file present, rule absent: two DISTINCT errors in the same file must not
  // collapse to one "|file" token (they'd hide a rotation between them). The key keeps them apart.
  expect(
    errorSetSignature([
      { key: "x.ts:1", file: "x.ts", message: "parse error" },
      { key: "x.ts:9", file: "x.ts", message: "type error" },
    ])
  ).not.toBe(
    errorSetSignature([{ key: "x.ts:1", file: "x.ts", message: "parse error" }])
  );
  // PARTIAL family — rule present, file absent: two distinct errors sharing a rule stay distinct.
  expect(errorSetSignature([{ key: "k1", rule: "r", message: "a" }])).not.toBe(
    errorSetSignature([{ key: "k2", rule: "r", message: "b" }])
  );
});

test("isNearGreenRotation: full window + count PLATEAU + changing signature", () => {
  // A near-green sample: fixed count 1 and phase 0 unless the test varies them. Each sample gets a
  // FRESH worktree rev by default (a real edit happened that cycle) — the #77 genuine-rotation
  // precondition; pass an explicit rev to model an unedited re-run.
  let revSeq = 0;
  const s = (
    sig: string,
    count = 1,
    phase = 0,
    rev = `rev-${String(revSeq++)}`
  ): { count: number; phase: number; sig: string; rev: string } => ({
    count,
    phase,
    sig,
    rev,
  });

  expect(ROTATION_WINDOW).toBe(3);
  // Fewer than a full window → can't conclude rotation yet.
  expect(isNearGreenRotation([s("a"), s("a")])).toBe(false);
  // A full window of the SAME signature = a genuinely stuck single error, NOT rotation
  // (the escalation ladder/expert handle that; rotation would mis-fire on it).
  expect(isNearGreenRotation([s("a"), s("a"), s("a")])).toBe(false);
  // GENUINE per-cycle rotation (identity changes EVERY cycle, under fresh edits) = rotation.
  expect(isNearGreenRotation([s("a"), s("b"), s("c")])).toBe(true);
  // #77 finding: distinct signatures but a CONSTANT rev (no edit between cycles — a flaky/stateful
  // gate or the check+settleGate double-run) is NOT rotation. Without the rev guard this fired and
  // wrongly stood the WS-B rollback net down.
  expect(
    isNearGreenRotation([
      s("a", 1, 0, "r"),
      s("b", 1, 0, "r"),
      s("c", 1, 0, "r"),
    ])
  ).toBe(false);
  // A 2-cycle RING (A→B→A) is genuine rotation too (no two consecutive equal).
  expect(isNearGreenRotation([s("a"), s("b"), s("a")])).toBe(true);
  // A single swap then stable (A,A,B — one identity change) is NOT rotation: it's progress toward
  // green, not a cycling frontier. Firing here would wrongly disable the WS-B rollback safety net.
  expect(isNearGreenRotation([s("a"), s("a"), s("b")])).toBe(false);
  expect(isNearGreenRotation([s("a"), s("b"), s("b")])).toBe(false);
  // A MOVING count (2→1→1) is progress/regress, NOT rotation — even though the signatures differ,
  // the window is not a plateau. This is the panel's count-blind false positive.
  expect(isNearGreenRotation([s("a", 2), s("b", 1), s("c", 1)])).toBe(false);
  // Same identity, count descends 2→1: not rotation (a plateau requires one count).
  expect(isNearGreenRotation([s("a", 2), s("a", 1), s("a", 1)])).toBe(false);
  // A plateau at count 2 that rotates IS rotation (near green isn't only count 1).
  expect(isNearGreenRotation([s("a", 2), s("b", 2), s("c", 2)])).toBe(true);
  // A MOVING gate-frontier PHASE is progress, NOT rotation: A@phase1 → B@phase2 → B@phase2 at a
  // stable count is the short-circuit gate revealing the next phase's work, not a rotating error.
  expect(isNearGreenRotation([s("a", 1, 1), s("b", 1, 2), s("b", 1, 2)])).toBe(
    false
  );
  // A rotation WITHIN one phase (constant phase, changing sig) still fires.
  expect(isNearGreenRotation([s("a", 1, 2), s("b", 1, 2), s("c", 1, 2)])).toBe(
    true
  );
  // Only the LAST window matters: an earlier rotation that has since stabilized is not rotation.
  expect(
    isNearGreenRotation([s("a"), s("b"), s("c"), s("d"), s("d"), s("d")])
  ).toBe(false);
});
