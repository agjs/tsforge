import { test, expect, describe } from "bun:test";

import { trackErrorAges, persistDetail } from "../src/loop/turn";
import type { ILoopState } from "../src/loop";
import { LOOP_LIMITS } from "../src/loop";
import type { ErrorSet, IErrorItem } from "../src/validate";

function freshState(): ILoopState {
  return {
    prevGateErrors: [],
    gateNoProgress: 0,
    errorAge: new Map(),
    lastGateCount: -1,
    edits: 0,
    regressions: 0,
    ttsrInterrupts: 0,
  };
}

function err(key: string, rule = "no-explicit-any"): IErrorItem {
  return {
    key,
    file: "src/views/Foo/index.tsx",
    rule,
    message: `${rule} at src/views/Foo/index.tsx`,
  };
}

/** Run `cycles` gate cycles, each returning the given error set, and collect the
 *  trackErrorAges verdict per cycle. */
function runCycles(state: ILoopState, sets: ErrorSet[]): (IErrorItem | null)[] {
  return sets.map((set) => trackErrorAges(state, set));
}

const N = LOOP_LIMITS.samePersist;

describe("trackErrorAges (samePersist no-progress guard)", () => {
  test("stops when ONE (file,rule) persists samePersist cycles, even as others churn", () => {
    const state = freshState();
    // The stubborn error A is present every cycle; a DIFFERENT error churns each
    // cycle, so the whole-set guard would never fire — but A keeps failing.
    const sets: ErrorSet[] = Array.from({ length: N }, (_, i) => [
      err("src/views/Foo/index.tsx:any"),
      err(
        `src/views/Foo/index.tsx:churn-${String(i)}`,
        `churn-rule-${String(i)}`
      ),
    ]);

    const verdicts = runCycles(state, sets);

    // Null until the threshold, then returns the persistent error A.
    expect(verdicts.slice(0, N - 1).every((v) => v === null)).toBe(true);
    expect(verdicts[N - 1]?.key).toBe("src/views/Foo/index.tsx:any");
    expect(verdicts[N - 1]?.rule).toBe("no-explicit-any");
  });

  test("does NOT stop while genuinely progressing (error clears before threshold)", () => {
    const state = freshState();
    // A present 3 cycles, then GONE (fixed), then a brand-new error appears.
    const sets: ErrorSet[] = [
      [err("k:A")],
      [err("k:A")],
      [err("k:A")],
      [err("k:B")], // A fixed → drops from the age map
      [err("k:B")],
      [err("k:C")],
    ];

    const verdicts = runCycles(state, sets);

    expect(verdicts.every((v) => v === null)).toBe(true);
  });

  test("a returning error starts its age over (no stale carry-over)", () => {
    const state = freshState();
    // A appears, disappears, reappears — its age must reset on the gap, so it
    // takes a fresh N consecutive cycles to trip.
    const sets: ErrorSet[] = [
      [err("k:A")], // age 1
      [err("k:A")], // age 2
      [], // A gone → dropped
      ...Array.from({ length: N - 1 }, () => [err("k:A")]), // ages 1..N-1
    ];

    const verdicts = runCycles(state, sets);

    expect(verdicts.every((v) => v === null)).toBe(true);
    expect(state.errorAge.get("k:A")).toBe(N - 1);
  });

  test("persistDetail names the rule, file, and attempt count", () => {
    const detail = persistDetail(err("k:A"));

    expect(detail).toContain("no-explicit-any");
    expect(detail).toContain("src/views/Foo/index.tsx");
    expect(detail).toContain(String(N));
  });
});
