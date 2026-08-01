import { test, expect } from "bun:test";
import { isWin32 } from "../src/lib/platform";

// isWin32 is the single source of truth for "are we on Windows" — platform-specific
// branches (the format janitor's project-prettier / backslash handling, the editor's
// Kitty-keyboard gate) depend on it. Lock it to the underlying platform value.
test("isWin32 reflects process.platform === 'win32'", () => {
  expect(isWin32()).toBe(process.platform === "win32");
});
