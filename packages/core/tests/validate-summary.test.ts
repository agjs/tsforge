import { test, expect, describe } from "bun:test";
import { summarizeValidateOutput } from "../src/cli/harness-review-mode";

// #63: the panel's pre-review validate summary. `passed` is the validate EXIT CODE (so a fixture
// "error" string never false-BLOCKs). The bug this locks: on PASS the summary must be EMPTY — the
// old code substring-matched /error/iu on green output too, polluting the verdict cache key (which
// includes the summary) so identical green diffs got different keys and the panel never cached.
describe("summarizeValidateOutput (#63 panel pre-validate summary)", () => {
  test("PASS (exit 0) yields an EMPTY summary even when green output contains the word 'error'", () => {
    const greenOutput = [
      "$ bun test packages --timeout 30000",
      "  [PASS] surfaces error handling for the empty case",
      "✓ 0 errors, 0 warnings",
      "==== 7/7 — ALL PASS ====",
    ].join("\n");

    expect(summarizeValidateOutput(greenOutput, 0)).toEqual({
      passed: true,
      failCount: 0,
      firstErrors: [],
    });
  });

  test("two DIFFERENT green outputs both summarize identically (stable cache key)", () => {
    const a = summarizeValidateOutput("ALL PASS\n0 errors", 0);
    const b = summarizeValidateOutput(
      "ALL PASS\nrun 'error-path' test\n0 errors",
      0
    );

    expect(a).toEqual(b);
  });

  test("FAIL (exit != 0) extracts the error lines", () => {
    const redOutput = [
      "$ bun run lint",
      "src/foo.ts:3:1 error  Unexpected any  @typescript-eslint/no-explicit-any",
      "clean line with no problem word",
      'error: script "lint" exited with code 1',
    ].join("\n");
    const summary = summarizeValidateOutput(redOutput, 1);

    expect(summary.passed).toBe(false);
    expect(summary.failCount).toBe(2);
    expect(summary.firstErrors).toEqual([
      "src/foo.ts:3:1 error  Unexpected any  @typescript-eslint/no-explicit-any",
      'error: script "lint" exited with code 1',
    ]);
  });

  test("FAIL caps firstErrors at 20 lines", () => {
    const many = Array.from({ length: 25 }, (_, i) => `error ${i}`).join("\n");
    const summary = summarizeValidateOutput(many, 1);

    expect(summary.firstErrors).toHaveLength(20);
    expect(summary.failCount).toBe(20);
  });
});
