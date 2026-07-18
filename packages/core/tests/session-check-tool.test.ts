import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider, IChatMessage } from "../src/inference";
import { Session } from "../src/loop";
import type { IGate } from "../src/gate/gate-runner";
import type { IValidateResult } from "../src/validate";

// WS-G end-to-end: the `check` tool must reach the tool context executeTool uses,
// survive the policy layer (it was DOA once — unknown→deny), and run the SAME gate
// settleGate runs (via runCheckGate → evaluateGate). These drive real Session turns.

/** A gate that always reports the given result — stands in for the injected
 *  per-slice boringstack gate so we can assert `check` returns ITS errors. */
function fixedGate(result: IValidateResult): IGate {
  return { run: async () => result };
}

const RED: IValidateResult = {
  passed: false,
  errors: [
    {
      key: "a",
      file: "src/x.ts",
      line: 3,
      rule: "no-unused-vars",
      message: "'y' unused",
    },
  ],
  output: "",
};

const GREEN: IValidateResult = { passed: true, errors: [], output: "" };

/** Emits ONE `check` call on turn 1, captures the tool-result message it gets back
 *  on turn 2, then reports done. `captured` holds the JSON the model saw. */
function checkingProvider(captured: { result: string | null }): IProvider {
  let turn = 0;

  return {
    async complete(messages: IChatMessage[]) {
      turn += 1;

      if (turn === 1) {
        return {
          content: "",
          toolCalls: [{ id: "1", name: "check", arguments: {} }],
        };
      }

      // Turn 2: the last tool message is the check result.
      const toolMsg = [...messages].reverse().find((m) => m.role === "tool");

      captured.result =
        typeof toolMsg?.content === "string" ? toolMsg.content : null;

      return { content: "done", toolCalls: [] };
    },
  };
}

test("offerCheck wires the seam: the model's check call returns the injected gate's structured errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-check-"));
  const captured: { result: string | null } = { result: null };

  try {
    const session = await Session.create({
      provider: checkingProvider(captured),
      cwd: dir,
      files: ["**/*"],
      offerCheck: true,
      gate: fixedGate(RED),
    });

    await session.send("build it");

    expect(captured.result).not.toBeNull();
    const parsed = JSON.parse(captured.result ?? "");

    expect(parsed.passed).toBe(false);
    expect(parsed.errorCount).toBe(1);
    expect(parsed.errors[0]).toEqual({
      file: "src/x.ts",
      line: 3,
      rule: "no-unused-vars",
      message: "'y' unused",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without offerCheck the check tool is not wired — doCheck reports it isn't available (seam is the cause)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-check-"));
  const captured: { result: string | null } = { result: null };

  try {
    const session = await Session.create({
      provider: checkingProvider(captured),
      cwd: dir,
      files: ["**/*"],
      // offerCheck omitted → runCheck seam absent
      gate: fixedGate(RED),
    });

    await session.send("build it");

    // The call still dispatches (policy allows it) but finds no seam.
    expect(captured.result ?? "").toContain("not available");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCheck reads the gate LAZILY — a mid-build setGate swap is honored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-check-"));
  const captured: { result: string | null } = { result: null };

  try {
    const session = await Session.create({
      provider: checkingProvider(captured),
      cwd: dir,
      files: ["**/*"],
      offerCheck: true,
      gate: fixedGate(GREEN), // initial gate: green
    });

    // The build swaps in the per-slice gate AFTER construction; check must see it.
    session.setGate(fixedGate(RED));

    await session.send("build it");

    const parsed = JSON.parse(captured.result ?? "");

    // Saw the NEW (red) gate, not the construction-time green one.
    expect(parsed.passed).toBe(false);
    expect(parsed.errorCount).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
