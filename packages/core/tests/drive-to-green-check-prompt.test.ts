import { test, expect } from "bun:test";
import { buildDriveToGreenSystem } from "../src/loop/prompt/prompt";
import { DEFAULT_CONVENTIONS } from "../src/infer-rules/conventions";

// WS-A4: the drive-to-green system prompt must not CONTRADICT the check tool. When
// check is offered (the boringstack build), the execution guidance promotes it; when
// not, the original "the gate runs automatically, don't run it yourself" stands.

test("with offerCheck, the drive-to-green prompt promotes the check tool", () => {
  const prompt = buildDriveToGreenSystem(DEFAULT_CONVENTIONS, true);

  expect(prompt).toContain("`check`");
  expect(prompt).toContain("before you stop");
  // Shell gate execution is still banned — check is a tool, not `bun run check`.
  expect(prompt).toContain("Do NOT run the gate through the SHELL");
  // The self-contradiction ("do NOT run ... the gate command yourself") is gone.
  expect(prompt).not.toContain("or the acceptance/gate command yourself");
});

test("without offerCheck, the drive-to-green prompt keeps the original gate guidance", () => {
  const prompt = buildDriveToGreenSystem(DEFAULT_CONVENTIONS, false);

  expect(prompt).toContain("the harness AUTOMATICALLY runs the gate");
  expect(prompt).toContain("Do NOT run `tsc`");
  // No mention of a check tool the model wasn't given.
  expect(prompt).not.toContain("`check`");
});

test("offerCheck defaults to false (non-build drive-to-green paths unchanged)", () => {
  expect(buildDriveToGreenSystem(DEFAULT_CONVENTIONS)).toBe(
    buildDriveToGreenSystem(DEFAULT_CONVENTIONS, false)
  );
});
