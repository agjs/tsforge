import { expect, test } from "bun:test";
import { forecastTotal } from "./forecast";

test("forecast keeps BANKER'S rounding — ties go to even", () => {
  // 12.5 → 12 (even), not 13. Rewiring this to the shared half-up helper
  // breaks it, which is the point: the two look alike and are not the same.
  expect(forecastTotal([120, 5], 10)).toBe(12);
  expect(forecastTotal([130, 5], 10)).toBe(14);
});
