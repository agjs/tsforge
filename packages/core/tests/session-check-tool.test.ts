import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider, IChatMessage } from "../src/inference";
import { Session } from "../src/loop";
import type { IGate } from "../src/gate/gate-runner";
import type { IValidateResult } from "../src/validate";
import { isRecord } from "../src/lib/guards/guards";

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

/** turn 1: create a file with an eslint-disable comment (→ touched, meta-rule red);
 *  turn 2: check (its result comes back turn 3); turn 3: capture it, then rewrite the
 *  file CLEAN so the gate greens and the session terminates. A red gate can't be
 *  "done"-ed out of, so we must actually fix it — and we never overwrite a captured
 *  result with null (a later compaction drops the tool message). */
function createThenCheckProvider(
  captured: { result: string | null },
  file: string
): IProvider {
  let turn = 0;

  return {
    async complete(messages: IChatMessage[]) {
      turn += 1;

      if (turn === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "1",
              name: "create",
              arguments: {
                file,
                content:
                  "// eslint-disable-next-line no-console\nconsole.log(1);\n",
              },
            },
          ],
        };
      }

      if (turn === 2) {
        return {
          content: "",
          toolCalls: [{ id: "2", name: "check", arguments: {} }],
        };
      }

      const toolMsg = [...messages].reverse().find((m) => m.role === "tool");

      if (typeof toolMsg?.content === "string" && captured.result === null) {
        captured.result = toolMsg.content;
      }

      // Green the gate (remove the disable comment) so the loop can terminate.
      return {
        content: "",
        toolCalls: [
          {
            id: "3",
            name: "create",
            arguments: { file, content: "export const x = 1;\n" },
          },
        ],
      };
    },
  };
}

test("check goes RED on a META_RULE error even when the gate command is GREEN (the gate-relaxed fix)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-check-"));
  const captured: { result: string | null } = { result: null };

  try {
    const session = await Session.create({
      provider: createThenCheckProvider(captured, "src/bad.ts"),
      cwd: dir,
      files: ["**/*"],
      offerCheck: true,
      // Gate COMMAND is green — only the meta-rule (no-eslint-disable-comments,
      // change-scoped to the file the model just wrote) makes it red.
      gate: fixedGate(GREEN),
    });

    await session.send("write a file");

    const parsed: { passed: boolean; errors: { rule?: string }[] } = JSON.parse(
      captured.result ?? ""
    );

    // If runCheck had regressed to ctx.gate.runner alone, this would be passed:true.
    expect(parsed.passed).toBe(false);
    expect(
      parsed.errors.some((e) => e.rule === "no-eslint-disable-comments")
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Extract an advertised tool's name via runtime narrowing — no `as` cast (house
 *  rule), since opts.tools is typed `unknown[]` at the provider boundary. */
function advertisedName(tool: unknown): string | undefined {
  if (!isRecord(tool)) {
    return undefined;
  }

  const fn = tool.function;

  if (!isRecord(fn) || typeof fn.name !== "string") {
    return undefined;
  }

  return fn.name;
}

/** Captures the tool NAMES the Session advertised to the model (opts.tools), then
 *  ends cleanly. Proves offerCheck actually reaches the advertised schema — not just
 *  that a forced check call happens to dispatch. */
function toolNameCapturingProvider(captured: { names: string[] }): IProvider {
  return {
    async complete(_messages, opts) {
      const tools = Array.isArray(opts?.tools) ? opts.tools : [];

      captured.names = tools.flatMap((t) => {
        const name = advertisedName(t);

        return name === undefined ? [] : [name];
      });

      return { content: "done", toolCalls: [] };
    },
  };
}

test("offerCheck:true makes the Session ADVERTISE check to the model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-check-"));
  const captured = { names: [] as string[] };

  try {
    const session = await Session.create({
      provider: toolNameCapturingProvider(captured),
      cwd: dir,
      files: ["**/*"],
      offerCheck: true,
      gate: fixedGate(GREEN),
    });

    await session.send("go");

    expect(captured.names).toContain("check");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without offerCheck the Session does NOT advertise check (the tool is un-discoverable)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-check-"));
  const captured = { names: [] as string[] };

  try {
    const session = await Session.create({
      provider: toolNameCapturingProvider(captured),
      cwd: dir,
      files: ["**/*"],
      gate: fixedGate(GREEN),
    });

    await session.send("go");

    expect(captured.names).not.toContain("check");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
