import { afterAll, describe, expect, test } from "bun:test";
import {
  cleanupScriptedSessions,
  runScriptedSession,
} from "./helpers/session-harness";
import { call } from "./helpers/scripted-model";

afterAll(cleanupScriptedSessions);

describe("session e2e — full agent loop via a scripted model", () => {
  test("a conversational turn (no tools) responds and makes no changes", async () => {
    const s = await runScriptedSession({
      task: "what is 2 + 2?",
      turns: [{ content: "4" }],
    });

    expect(s.status).toBe("responded");
    expect(s.model.calls).toBe(1);
    expect(s.sawKind("edit")).toBe(false);
    expect(s.sawKind("create")).toBe(false);
  });

  test("the model creates a file via the create tool; it lands on disk", async () => {
    const s = await runScriptedSession({
      task: "create hello.ts",
      turns: [
        {
          toolCalls: [
            call("create", {
              file: "hello.ts",
              content: "export const hi = 1;\n",
            }),
          ],
        },
        { content: "done" }, // yield → loop ends
      ],
    });

    expect(s.fileExists("hello.ts")).toBe(true);
    expect(s.fileText("hello.ts")).toContain("export const hi = 1;");
    const creates = s.eventsOfKind("create");

    expect(creates.length).toBe(1);
    expect(creates[0]?.file).toContain("hello.ts");
  });

  test("a passing gate (accept) confirms the change as done", async () => {
    const s = await runScriptedSession({
      task: "create a file then finish",
      accept: 'node -e "process.exit(0)"', // portable always-pass gate
      turns: [
        {
          toolCalls: [
            call("create", { file: "a.ts", content: "export const a = 1;\n" }),
          ],
        },
        { content: "all set" }, // yield with a pending mutation → gate fires
      ],
    });

    expect(s.status).toBe("done");
    const validated = s.eventsOfKind("validated");

    expect(validated.some((e) => e.passed === true)).toBe(true);
  });

  test("a failing gate then a fix: red → repair → green → done", async () => {
    const s = await runScriptedSession({
      task: "make the gate pass",
      // Gate passes only once the model has created fixed.txt.
      accept:
        "node -e \"process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)\"",
      maxTurns: 8,
      turns: [
        // Turn 1: a wrong mutation (creates the wrong file).
        {
          toolCalls: [call("create", { file: "wrong.txt", content: "nope\n" })],
        },
        // Turn 2: yield → gate runs → FAILS (no fixed.txt yet).
        { content: "I think that's it" },
        // Turn 3: react to the failure by creating the right file.
        { toolCalls: [call("create", { file: "fixed.txt", content: "ok\n" })] },
        // Turn 4: yield → gate runs → PASSES.
        { content: "fixed now" },
      ],
    });

    expect(s.status).toBe("done");
    expect(s.fileExists("fixed.txt")).toBe(true);
    const validated = s.eventsOfKind("validated");

    // The gate was seen failing and then passing.
    expect(validated.some((e) => e.passed === false)).toBe(true);
    expect(validated.some((e) => e.passed === true)).toBe(true);
  });

  test("an out-of-scope create is rejected and never written", async () => {
    const s = await runScriptedSession({
      task: "try to escape scope",
      files: ["allowed/**"], // only allowed/ is editable
      turns: [
        { toolCalls: [call("create", { file: "secret.ts", content: "x\n" })] },
        { content: "tried" },
      ],
    });

    expect(s.fileExists("secret.ts")).toBe(false);
  });

  test("the run tool executes a shell command and reports its result", async () => {
    const s = await runScriptedSession({
      task: "run a command",
      turns: [
        { toolCalls: [call("run", { command: "echo hello-from-e2e" })] },
        { content: "ran it" },
      ],
    });

    const runs = s.eventsOfKind("run");

    expect(runs.length).toBe(1);
    expect(runs[0]?.output ?? "").toContain("hello-from-e2e");
    expect(runs[0]?.exitCode).toBe(0);
  });
});

describe("session e2e — read/edit round-trips and multi-file builds", () => {
  test("the edit tool replaces a snippet in a seeded file", async () => {
    const s = await runScriptedSession({
      task: "bump the constant",
      seed: { "app.ts": "export const x = 1;\n" },
      turns: [
        {
          toolCalls: [
            call("edit", {
              file: "app.ts",
              oldString: "const x = 1",
              newString: "const x = 2",
            }),
          ],
        },
        { content: "bumped" },
      ],
    });

    expect(s.fileText("app.ts")).toContain("const x = 2");
    expect(s.sawKind("edit")).toBe(true);
  });

  test("a read tool result flows back into the conversation for the model", async () => {
    const s = await runScriptedSession({
      task: "read the secret then echo it",
      seed: { "data.txt": "SECRET-VALUE-42\n" },
      turns: [
        { toolCalls: [call("read", { file: "data.txt" })] },
        // This turn REACTS to the read result: the tool output is now in the
        // conversation, so the model can copy the value into a new file.
        (messages) => {
          const transcript = messages.map((m) => m.content).join("\n");
          const saw = transcript.includes("SECRET-VALUE-42");

          return {
            toolCalls: [
              call("create", {
                file: "echo.txt",
                content: saw ? "SECRET-VALUE-42\n" : "MISSING\n",
              }),
            ],
          };
        },
        { content: "done" },
      ],
    });

    // The read result reached the model, so it wrote the real value (not MISSING).
    expect(s.fileText("echo.txt")).toContain("SECRET-VALUE-42");
  });

  test("a multi-file build creates every file in one session", async () => {
    const s = await runScriptedSession({
      task: "build a small module",
      turns: [
        {
          toolCalls: [
            call("create", {
              file: "src/a.ts",
              content: "export const a = 1;\n",
            }),
          ],
        },
        {
          toolCalls: [
            call("create", {
              file: "src/b.ts",
              content: "export const b = 2;\n",
            }),
          ],
        },
        {
          toolCalls: [
            call("create", {
              file: "src/index.ts",
              content: "export * from './a';\nexport * from './b';\n",
            }),
          ],
        },
        { content: "module built" },
      ],
    });

    expect(s.fileExists("src/a.ts")).toBe(true);
    expect(s.fileExists("src/b.ts")).toBe(true);
    expect(s.fileExists("src/index.ts")).toBe(true);
    expect(s.eventsOfKind("create").length).toBe(3);
  });
});

describe("session e2e — plan mode (read-only) and auto-fix", () => {
  test("plan mode rejects a create — the file is never written", async () => {
    const s = await runScriptedSession({
      task: "in plan mode, try to write a file",
      policyMode: "plan",
      turns: [
        {
          toolCalls: [
            call("create", { file: "should-not-exist.ts", content: "x\n" }),
          ],
        },
        { content: "tried to write" },
      ],
    });

    // The read-only guarantee: no write escapes plan mode.
    expect(s.fileExists("should-not-exist.ts")).toBe(false);
  });

  test("plan mode still allows a read tool", async () => {
    const s = await runScriptedSession({
      task: "read in plan mode",
      policyMode: "plan",
      seed: { "notes.txt": "PLAN-MODE-READ-OK\n" },
      turns: [
        { toolCalls: [call("read", { file: "notes.txt" })] },
        { content: "read it" },
      ],
    });

    // Reading is permitted; the result reached the conversation.
    expect(s.status).toBe("responded");
  });

  test("the auto-fix command runs before re-validating the gate", async () => {
    const s = await runScriptedSession({
      task: "create a file; fix runs before the gate",
      // fix writes a marker; gate passes only if the marker exists → proves fix ran.
      fix: "node -e \"require('fs').writeFileSync('fix-ran.marker','')\"",
      accept:
        "node -e \"process.exit(require('fs').existsSync('fix-ran.marker') ? 0 : 1)\"",
      maxTurns: 6,
      turns: [
        {
          toolCalls: [
            call("create", { file: "a.ts", content: "export const a = 1;\n" }),
          ],
        },
        { content: "done" }, // yield → fix runs → gate checks the marker
      ],
    });

    expect(s.fileExists("fix-ran.marker")).toBe(true);
    expect(s.status).toBe("done");
  });
});
