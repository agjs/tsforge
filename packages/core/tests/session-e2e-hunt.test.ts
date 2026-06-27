import { afterAll, describe, expect, test } from "bun:test";
import {
  cleanupScriptedSessions,
  runScriptedSession,
} from "./helpers/session-harness";
import { call } from "./helpers/scripted-model";

afterAll(cleanupScriptedSessions);

// Adversarial probes: edge cases where bugs hide. Each documents the EXPECTED
// robust behavior; a failure here is a real harness bug found by the e2e layer.
describe("session e2e — adversarial bug hunt", () => {
  test("edit with a non-matching oldString does not corrupt the file", async () => {
    const s = await runScriptedSession({
      task: "edit a snippet that isn't there",
      seed: { "app.ts": "export const x = 1;\n" },
      turns: [
        {
          toolCalls: [
            call("edit", {
              file: "app.ts",
              oldString: "THIS DOES NOT EXIST",
              newString: "replacement",
            }),
          ],
        },
        { content: "tried" },
      ],
    });

    // The file must be untouched (no partial/garbage write).
    expect(s.fileText("app.ts")).toBe("export const x = 1;\n");
  });

  test("edit with a non-unique oldString is rejected (must be unique)", async () => {
    const s = await runScriptedSession({
      task: "ambiguous edit",
      seed: { "app.ts": "const a = 1;\nconst a = 1;\n" },
      turns: [
        {
          toolCalls: [
            call("edit", {
              file: "app.ts",
              oldString: "const a = 1;",
              newString: "const a = 2;",
            }),
          ],
        },
        { content: "tried" },
      ],
    });

    // Ambiguous → must not silently replace just one; file stays intact.
    expect(s.fileText("app.ts")).toBe("const a = 1;\nconst a = 1;\n");
  });

  test("create over an existing file does not silently clobber it", async () => {
    const s = await runScriptedSession({
      task: "create over an existing file",
      seed: { "exists.ts": "export const original = true;\n" },
      turns: [
        {
          toolCalls: [
            call("create", {
              file: "exists.ts",
              content: "export const clobbered = true;\n",
            }),
          ],
        },
        { content: "tried" },
      ],
    });

    // `create` is for NEW files — it should not blow away existing content.
    expect(s.fileText("exists.ts")).toContain("original");
  });

  test("a failing shell command reports a non-zero exit, loop continues", async () => {
    const s = await runScriptedSession({
      task: "run a failing command",
      turns: [
        { toolCalls: [call("run", { command: 'node -e "process.exit(7)"' })] },
        { content: "saw the failure" },
      ],
    });

    const runs = s.eventsOfKind("run");

    expect(runs[0]?.exitCode).toBe(7);
    expect(s.status).toBe("responded");
  });

  test("a model that never yields hits maxTurns and stops (no infinite loop)", async () => {
    const neverYield = () => ({
      toolCalls: [call("run", { command: "echo loop" })],
    });
    const s = await runScriptedSession({
      task: "spin forever",
      maxTurns: 3,
      turns: [neverYield, neverYield, neverYield, neverYield, neverYield],
    });

    // The turn cap must bound the run.
    expect(s.model.calls).toBeLessThanOrEqual(4);
  });

  test("malformed tool args (create missing content) do not crash the loop", async () => {
    const s = await runScriptedSession({
      task: "send a malformed create",
      turns: [
        { toolCalls: [call("create", { file: "x.ts" })] }, // no content
        { content: "recovered" },
      ],
    });

    // The loop must survive and reach a terminal state, not throw.
    expect(["responded", "done", "stuck"].includes(s.status)).toBe(true);
  });

  test("a gate command that errors (not just fails) is handled", async () => {
    const s = await runScriptedSession({
      task: "gate command itself errors",
      accept: "this-command-does-not-exist-xyz",
      maxTurns: 4,
      turns: [
        {
          toolCalls: [
            call("create", { file: "a.ts", content: "export const a = 1;\n" }),
          ],
        },
        { content: "done" },
      ],
    });

    // A broken gate command must not crash; it should resolve to a verdict.
    expect(["done", "stuck", "responded"].includes(s.status)).toBe(true);
  });
});
