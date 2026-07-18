import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDriveToGreenSystem } from "../src/loop/prompt/prompt";
import { DEFAULT_CONVENTIONS } from "../src/infer-rules/conventions";
import type { IProvider, IChatMessage } from "../src/inference";
import { Session } from "../src/loop";

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

// Session-level wiring: the pure-builder tests above pass even if Session stops
// forwarding cfg.offerCheck. These drive a real Session and inspect the SYSTEM
// message, so a reverted one-liner (tool advertised + gate-ban prompt) fails here.
function systemCapturingProvider(cap: { system: string }): IProvider {
  return {
    async complete(messages: IChatMessage[]) {
      const sys = messages.find((m) => m.role === "system");

      cap.system = typeof sys?.content === "string" ? sys.content : "";

      return { content: "done", toolCalls: [] };
    },
  };
}

test("a drive-to-green Session with offerCheck puts the check guidance in its system prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-dtg-"));
  const cap = { system: "" };

  try {
    const session = await Session.create({
      provider: systemCapturingProvider(cap),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
      offerCheck: true,
    });

    await session.send("go");

    expect(cap.system).toContain("`check`");
    expect(cap.system).not.toContain("or the acceptance/gate command yourself");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a drive-to-green Session WITHOUT offerCheck keeps the original gate guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-dtg-"));
  const cap = { system: "" };

  try {
    const session = await Session.create({
      provider: systemCapturingProvider(cap),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
    });

    await session.send("go");

    expect(cap.system).not.toContain("`check`");
    expect(cap.system).toContain("Do NOT run `tsc`");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
