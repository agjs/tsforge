import { expect, test } from "bun:test";
import { roundHalfUp } from "./money";

test("rounds halves away from zero, in both directions", () => {
  expect(roundHalfUp(125, 10)).toBe(13);
  // The trap: -12.5 must go to -13, not -12. Math.round would give -12.
  expect(roundHalfUp(-125, 10)).toBe(-13);
});

test("leaves non-ties alone", () => {
  expect(roundHalfUp(124, 10)).toBe(12);
  expect(roundHalfUp(126, 10)).toBe(13);
  expect(roundHalfUp(-124, 10)).toBe(-12);
});
