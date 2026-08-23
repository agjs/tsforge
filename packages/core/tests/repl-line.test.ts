import { test, expect } from "bun:test";
import { shouldDispatchReplLine } from "../src/cli/repl-line";

test("real prompts dispatch", () => {
  expect(shouldDispatchReplLine("hello")).toBe(true);
  expect(shouldDispatchReplLine("  add a flap  ")).toBe(true);
  expect(shouldDispatchReplLine("approve")).toBe(true);
});

test("empty and mouse CSI never dispatch", () => {
  expect(shouldDispatchReplLine("")).toBe(false);
  expect(shouldDispatchReplLine("   ")).toBe(false);
  expect(shouldDispatchReplLine("\x1b[<0;23;22M")).toBe(false);
  expect(shouldDispatchReplLine("0;23;22M")).toBe(false);
  expect(shouldDispatchReplLine("[<0;23;22M")).toBe(false);
});
