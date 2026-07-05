import { test, expect } from "bun:test";
import { TtsrManager, type ITtsrRule } from "../src/loop/ttsr";

const RULE_A: ITtsrRule = {
  name: "no-as-any",
  condition: [/\bas\s+any\b/],
  scope: "tool-args",
  guidance: "Type the value properly instead of casting to any.",
  repeatMode: "cooldown",
  repeatGap: 0,
};

const RULE_B: ITtsrRule = {
  name: "no-ts-ignore",
  condition: [/@ts-ignore/],
  scope: "tool-args",
  guidance: "Fix the type error instead of suppressing it.",
  repeatMode: "cooldown",
  repeatGap: 0,
};

function manager(): TtsrManager {
  const m = new TtsrManager();

  m.addRule(RULE_A);
  m.addRule(RULE_B);

  return m;
}

test("recordInterrupt silences a rule only at its per-rule cap", () => {
  const m = manager();

  expect(m.recordInterrupt("no-as-any")).toBe(false); // 1st interrupt: warn only
  expect(m.recordInterrupt("no-as-any")).toBe(true); // 2nd: silenced
  expect(m.recordInterrupt("no-as-any")).toBe(false); // already silenced: no re-report
});

test("a silenced rule stops matching while OTHER rules keep watching", () => {
  const m = manager();

  expect(
    m.checkDelta("const x = y as any;", { source: "tool-args" })?.name
  ).toBe("no-as-any");

  m.recordInterrupt("no-as-any");
  m.recordInterrupt("no-as-any");
  m.resetBuffer();

  // The noisy rule no longer fires…
  expect(
    m.checkDelta("const z = w as any;", { source: "tool-args" })
  ).toBeNull();

  m.resetBuffer();

  // …but the previous behavior (manager-wide disable) would have missed this:
  expect(m.checkDelta("// @ts-ignore", { source: "tool-args" })?.name).toBe(
    "no-ts-ignore"
  );
});

test("manager-wide disable still silences everything (global backstop)", () => {
  const m = manager();

  m.disable();

  expect(
    m.checkDelta("const x = y as any;", { source: "tool-args" })
  ).toBeNull();
  expect(m.checkDelta("// @ts-ignore", { source: "tool-args" })).toBeNull();
});

test("resetInterrupts re-arms a silenced rule (per-send reset in a persistent session)", () => {
  const m = manager();

  m.recordInterrupt("no-as-any");
  m.recordInterrupt("no-as-any");
  m.resetBuffer();

  // Silenced within the drive…
  expect(
    m.checkDelta("const z = w as any;", { source: "tool-args" })
  ).toBeNull();

  // …but a new user message resets it, so the rule fires again.
  m.resetInterrupts();
  m.resetBuffer();

  expect(
    m.checkDelta("const q = r as any;", { source: "tool-args" })?.name
  ).toBe("no-as-any");

  // The silencing counter also resets: it takes the full cap again to re-silence.
  expect(m.recordInterrupt("no-as-any")).toBe(false);
  expect(m.recordInterrupt("no-as-any")).toBe(true);
});

test("resetInterrupts re-enables a globally disabled manager", () => {
  const m = manager();

  m.disable();
  m.resetInterrupts();

  expect(
    m.checkDelta("const x = y as any;", { source: "tool-args" })?.name
  ).toBe("no-as-any");
});
