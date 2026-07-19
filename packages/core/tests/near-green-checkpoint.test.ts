import { test, expect } from "bun:test";
import {
  shouldCheckpoint,
  shouldRollback,
  NEAR_GREEN_N,
  NEAR_GREEN_M,
  type INearGreenCheckpoint,
} from "../src/loop/near-green-checkpoint";

// WS-B: the pure checkpoint/rollback decision, unit-locked with the Phase 0a thresholds
// (N=2, M=3) away from the Session's file I/O. Real spray data from inv157/inv156.

test("defaults match Phase 0a (N=2 near-green ceiling, M=3 spray delta)", () => {
  expect(NEAR_GREEN_N).toBe(2);
  expect(NEAR_GREEN_M).toBe(3);
});

test("shouldCheckpoint: a NEW LOW at 1..N is worth protecting; 0 and >N are not", () => {
  // Near-green new lows → checkpoint.
  expect(shouldCheckpoint(1, true)).toBe(true);
  expect(shouldCheckpoint(2, true)).toBe(true);
  // Zero = the build just went green — nothing to protect.
  expect(shouldCheckpoint(0, true)).toBe(false);
  // Above the near-green ceiling → not yet worth a checkpoint.
  expect(shouldCheckpoint(3, true)).toBe(false);
  expect(shouldCheckpoint(8, true)).toBe(false);
  // Not a new low → never checkpoint (even if near green).
  expect(shouldCheckpoint(1, false)).toBe(false);
});

function cp(errorCount: number): INearGreenCheckpoint {
  return { errorCount, files: new Map(), errors: [] };
}

test("shouldRollback: fires on a damaging near-green spray, not on benign wobble", () => {
  // The Phase 0a damaging sprays (prev∈{1,2}, jump≥4) → roll back.
  expect(shouldRollback(cp(1), 8)).toBe(true); // inv157 1→8 (+7)
  expect(shouldRollback(cp(2), 6)).toBe(true); // 2→6 (+4)
  expect(shouldRollback(cp(2), 30)).toBe(true); // 2→30 (+28)
  // Benign wobble (jump ≤ M) → NO rollback (normal near-green churn).
  expect(shouldRollback(cp(1), 2)).toBe(false); // 1→2 (+1)
  expect(shouldRollback(cp(2), 5)).toBe(false); // 2→5 (+3, not > M)
  expect(shouldRollback(cp(1), 4)).toBe(false); // 1→4 (+3, not > M)
  expect(shouldRollback(cp(1), 5)).toBe(true); // 1→5 (+4) is over the line
});

test("shouldRollback: no checkpoint → never rolls back", () => {
  expect(shouldRollback(undefined, 99)).toBe(false);
});

test("shouldRollback: a checkpoint above the near-green ceiling never rolls back", () => {
  // Defensive: a checkpoint should only ever be near-green, but if one at >N somehow
  // exists, it must not trigger a rollback (that's not the near-green case WS-B targets).
  expect(shouldRollback(cp(5), 59)).toBe(false);
});

test("thresholds are overridable (for config / A/B)", () => {
  expect(shouldCheckpoint(3, true, 4)).toBe(true); // wider ceiling
  expect(shouldRollback(cp(3), 7, 4, 3)).toBe(true); // N=4,M=3 → 3→7 (+4)
  expect(shouldRollback(cp(1), 3, 2, 1)).toBe(true); // M=1 → 1→3 (+2)
});
