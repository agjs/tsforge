import { test, expect, describe } from "bun:test";
import { clampRatio } from "../src/lib/ratio";

describe("clampRatio", () => {
  test("passes an in-range share through untouched", () => {
    expect(clampRatio(0.9)).toBe(0.9);
    expect(clampRatio(0)).toBe(0);
    expect(clampRatio(1)).toBe(1);
  });

  test("saturates an over-report UP, never down to zero", () => {
    // 0 is the reserved "the prompt prefix went cold" reading. Folding the
    // strongest over-report into the strongest under-report would invert the
    // signal — and `JSON.parse('1e999')` is Infinity, so this is reachable from
    // a server response, not just from arithmetic.
    expect(clampRatio(5)).toBe(1);
    expect(clampRatio(Number.POSITIVE_INFINITY)).toBe(1);
  });

  test("saturates an under-report down to zero", () => {
    expect(clampRatio(-2)).toBe(0);
    expect(clampRatio(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  test("reports NaN as unmeasurable rather than picking an end", () => {
    // NaN comes from 0/0 or Infinity/Infinity and has no defensible position on
    // the scale, so it must not be reported as either a hit or a miss.
    expect(clampRatio(Number.NaN)).toBeNull();
  });
});
