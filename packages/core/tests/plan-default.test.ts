import { test, expect } from "bun:test";
import {
  resolveInitialPlanMode,
  type IPlanModeArgs,
} from "../src/cli/plan-default";
import type { PolicyMode } from "../src/policy";

function args(over: Partial<IPlanModeArgs> = {}): IPlanModeArgs {
  return { plan: false, noPlan: false, policyMode: "", ...over };
}

test("a fresh session with no flags defaults to plan mode", () => {
  expect(resolveInitialPlanMode(args(), undefined, "default")).toBe(true);
});

test("--no-plan opts out", () => {
  expect(
    resolveInitialPlanMode(args({ noPlan: true }), undefined, "default")
  ).toBe(false);
});

test("--plan forces plan mode on even against a non-plan base", () => {
  expect(resolveInitialPlanMode(args({ plan: true }), undefined, "ci")).toBe(
    true
  );
});

test("--plan wins over --no-plan (explicit request beats opt-out)", () => {
  expect(
    resolveInitialPlanMode(
      args({ plan: true, noPlan: true }),
      undefined,
      "default"
    )
  ).toBe(true);
});

test("an explicit non-plan --policy-mode opts out", () => {
  expect(
    resolveInitialPlanMode(
      args({ policyMode: "default" }),
      undefined,
      "default"
    )
  ).toBe(false);
  expect(
    resolveInitialPlanMode(
      args({ policyMode: "acceptEdits" }),
      undefined,
      "acceptEdits"
    )
  ).toBe(false);
});

test("--policy-mode plan turns plan mode on", () => {
  expect(
    resolveInitialPlanMode(args({ policyMode: "plan" }), undefined, "plan")
  ).toBe(true);
});

test("a config policy.mode of non-plan (no CLI override) opts out", () => {
  const nonPlan: PolicyMode[] = [
    "acceptEdits",
    "ci",
    "dontAsk",
    "bypassPermissions",
  ];

  for (const mode of nonPlan) {
    expect(resolveInitialPlanMode(args(), undefined, mode)).toBe(false);
  }
});

test("a config policy.mode of plan (no CLI override) turns plan mode on", () => {
  expect(resolveInitialPlanMode(args(), undefined, "plan")).toBe(true);
});

test("a resumed session restores its saved posture, ignoring the default", () => {
  // Resumed OFF stays off even with a plan-first base.
  expect(resolveInitialPlanMode(args(), false, "default")).toBe(false);
  // Resumed ON stays on even with a non-plan base.
  expect(resolveInitialPlanMode(args(), true, "ci")).toBe(true);
});

test("resumed posture wins over --no-plan / --plan (the saved read-only guarantee)", () => {
  expect(resolveInitialPlanMode(args({ noPlan: true }), true, "default")).toBe(
    true
  );
  expect(resolveInitialPlanMode(args({ plan: true }), false, "default")).toBe(
    false
  );
});
