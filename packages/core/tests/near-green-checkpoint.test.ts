import { test, expect } from "bun:test";
import {
  shouldCheckpoint,
  shouldRollback,
  isCompletionClass,
  allCompletionClass,
  nextCompletionPhase,
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

test("isCompletionClass: only reliable add-code rules (reachability/i18n-locale-keys-used), bare or prefixed", () => {
  expect(isCompletionClass(err("reachability"))).toBe(true);
  expect(isCompletionClass(err("i18n-locale-keys-used"))).toBe(true);
  expect(isCompletionClass(err("plugin/i18n-locale-keys-used"))).toBe(true);
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
