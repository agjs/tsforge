import { test, expect } from "bun:test";
import { orderTotal } from "./total";

test("orderTotal sums then rounds half-up", () => {
  expect(orderTotal([120, 5], 10)).toBe(13);
  expect(orderTotal([-120, -5], 10)).toBe(-13);
});
