import { expect, test } from "bun:test";
import { add } from "./add";

test("adds two cent amounts", () => {
  expect(add(199, 1)).toBe(200);
});

test("adds zero", () => {
  expect(add(500, 0)).toBe(500);
});

test("adds negatives (refunds)", () => {
  expect(add(500, -200)).toBe(300);
});
