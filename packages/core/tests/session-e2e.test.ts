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
      accept: "true", // gate always passes
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
      accept: "test -f fixed.txt",
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
