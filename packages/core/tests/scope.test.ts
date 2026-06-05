import { test, expect } from "bun:test";
import { isInScope } from "../src/lib/scope";

test("matches exact paths and globs; empty patterns match nothing", () => {
  expect(isInScope("todo.ts", ["todo.ts"])).toBe(true);
  expect(isInScope("todo.test.ts", ["todo.ts"])).toBe(false);
  expect(isInScope("src/a/b.ts", ["src/**"])).toBe(true);
  expect(isInScope("x.ts", [])).toBe(false);
});
