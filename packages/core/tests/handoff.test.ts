import { describe, it, expect } from "bun:test";
import { buildHandoffAsk } from "../src/loop/turn";
import { STUCK_REASON } from "../src/loop/loop.constants";

describe("buildHandoffAsk", () => {
  it("derives a non-empty ask from a steer and error set", () => {
    const finalSteer = "The linter keeps catching unsafe type patterns. Read the error messages below, identify the root mismatch, and try a fundamentally different type strategy.";
    const persistingErrors = [
      "src/index.ts:no-unsafe-argument",
      "src/types.ts:no-explicit-any",
    ];

    const ask = buildHandoffAsk(finalSteer, persistingErrors);

    expect(ask).toBeTruthy();
    expect(ask.length).toBeGreaterThan(0);
    expect(ask).toContain("unsafe");
  });

  it("handles empty error list gracefully", () => {
    const finalSteer = "Make progress on the blocking issue.";
    const persistingErrors: string[] = [];

    const ask = buildHandoffAsk(finalSteer, persistingErrors);

    expect(ask).toBeTruthy();
    expect(ask.length).toBeGreaterThan(0);
  });

  it("handles empty steer gracefully", () => {
    const finalSteer = "";
    const persistingErrors = ["src/index.ts:some-rule"];

    const ask = buildHandoffAsk(finalSteer, persistingErrors);

    expect(ask).toBeTruthy();
    expect(ask.length).toBeGreaterThan(0);
  });

  it("is pure (same inputs give same output)", () => {
    const steer = "Reset and try a different approach.";
    const errors = ["file.ts:rule1", "file.ts:rule2"];

    const ask1 = buildHandoffAsk(steer, errors);
    const ask2 = buildHandoffAsk(steer, errors);

    expect(ask1).toBe(ask2);
  });
});
