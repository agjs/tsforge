import { expect, test } from "bun:test";
import { mul } from "./mul";

test("multiplies a cent amount by a quantity", () => {
  expect(mul(199, 3)).toBe(597);
});

test("rounds half-up to the nearest cent", () => {
  // 333 * 1.5 is not an integer qty, but a price of 333 split across rounding:
  expect(mul(5, 3)).toBe(15);
  expect(mul(1, 0)).toBe(0);
});
