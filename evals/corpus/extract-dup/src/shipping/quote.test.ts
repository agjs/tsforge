import { test, expect } from "bun:test";
import { shippingQuote } from "./quote";

test("shippingQuote sums then rounds half-up", () => {
  expect(shippingQuote([120, 5], 10)).toBe(13);
  expect(shippingQuote([-120, -5], 10)).toBe(-13);
});
