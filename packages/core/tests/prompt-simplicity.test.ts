import { test, expect, afterEach } from "bun:test";
import {
  buildSystemPrompt,
  SCRATCH_SIMPLICITY_GUIDANCE,
} from "../src/loop/prompt";
import { isWebStack } from "../src/stack-detection";
import type { IStackProfile } from "../src/stack-detection";

const SIMPLICITY = "TSFORGE_SIMPLICITY";
const before = process.env[SIMPLICITY];

afterEach(() => {
  // Restore (or set "0" = off, the default) without `delete` (banned on dynamic keys).
  process.env[SIMPLICITY] = before ?? "0";
});

function profile(packs: string[]): IStackProfile {
  return {
    name: packs.join("+"),
    packs,
    confidence: "certain",
    reason: "test",
  };
}

const coreStack = profile(["generic-ts", "typescript-core"]);
const webStack = profile([
  "generic-ts",
  "react",
  "react-component-architecture",
]);

test("isWebStack: true for react packs, false for a plain TS stack", () => {
  expect(isWebStack(webStack)).toBe(true);
  expect(isWebStack(coreStack)).toBe(false);
});

test("flag OFF → no simplicity block (current behaviour)", () => {
  process.env[SIMPLICITY] = "0";
  expect(buildSystemPrompt(false, coreStack)).not.toContain(
    SCRATCH_SIMPLICITY_GUIDANCE
  );
});

test("flag ON + from-scratch + non-web → simplicity block appended", () => {
  process.env[SIMPLICITY] = "1";
  const out = buildSystemPrompt(false, coreStack);

  expect(out).toContain(SCRATCH_SIMPLICITY_GUIDANCE);
});

test("flag ON but existing code → no block (edits, not from scratch)", () => {
  process.env[SIMPLICITY] = "1";
  expect(buildSystemPrompt(true, coreStack)).not.toContain(
    SCRATCH_SIMPLICITY_GUIDANCE
  );
});

test("flag ON but web stack → no block (views architecture needs many files)", () => {
  process.env[SIMPLICITY] = "1";
  expect(buildSystemPrompt(false, webStack)).not.toContain(
    SCRATCH_SIMPLICITY_GUIDANCE
  );
});

test("flag ON + no stack + from-scratch → block appended (undefined ≠ web)", () => {
  process.env[SIMPLICITY] = "1";
  expect(buildSystemPrompt(false, undefined)).toContain(
    SCRATCH_SIMPLICITY_GUIDANCE
  );
});
