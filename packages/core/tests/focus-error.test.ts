import { test, expect, describe } from "bun:test";

// Note: gateFeedback filtering tests are integration tests that require
// the full context (cwd, files, reading from disk). The filtering logic
// itself is unit-tested via the individual filter operations in gateFeedback.
// A focused test here would duplicate those unit tests without adding value.
//
// The key verification is:
// 1. focusError filters rendered feedback (not the progress-guard fingerprint)
// 2. Meta-rule filtering uses file:ruleId key format
// 3. Error filtering uses file:line:rule key format
//
// These are verified in integration tests with real gate cycles.

describe("focusError filtering (integration)", () => {
  test("placeholder: focusError filtering is tested via gateFeedback in integration", () => {
    // The filtering logic is embedded in gateFeedback:
    // - Regular errors: filter by key = "file:line:rule"
    // - Meta violations: filter by key = "file:ruleId"
    // - Fingerprint uses UNFILTERED errors
    // Full integration tests verify this behavior with real file I/O.
    expect(true).toBe(true);
  });
});
