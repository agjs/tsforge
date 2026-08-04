import { test, expect } from "bun:test";
import { invoiceTotal } from "./invoice";

test("invoiceTotal sums then rounds half-up", () => {
  expect(invoiceTotal([120, 5], 10)).toBe(13);
  expect(invoiceTotal([-120, -5], 10)).toBe(-13);
});
