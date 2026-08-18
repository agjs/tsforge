import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IProvider, IModelResponse, IChatMessage } from "../src/inference";
import {
  AgentRunner,
  AGENT_LIMITS,
  AGENT_FINAL_TURN_STRUCTURED,
  AGENT_FINAL_TURN_TEXT,
} from "../src/agent/agent-runner";
import { NO_SALVAGE_FALLBACK } from "../src/agent/salvage";

/** A provider that replays a fixed queue of responses (repeats the last one). */
function scripted(queue: IModelResponse[]): {
  provider: IProvider;
  seenTools: () => string[];
  calls: () => number;
  lastMessages: () => IChatMessage[];
} {
  let toolNames: string[] = [];
  let messages: IChatMessage[] = [];
  let i = 0;

  return {
    provider: {
      complete(msgs, opts) {
        messages = [...msgs];
        const raw = opts?.tools ?? [];

        toolNames = raw.flatMap((t) =>
          typeof t === "object" &&
          t !== null &&
          "function" in t &&
          typeof t.function === "object" &&
          t.function !== null &&
          "name" in t.function &&
          typeof t.function.name === "string"
            ? [t.function.name]
            : []
        );

        const res = queue[Math.min(i, queue.length - 1)];

        i += 1;

        if (res === undefined) {
          throw new Error("scripted queue is empty");
        }

        return Promise.resolve(res);
      },
    },
    seenTools: () => toolNames,
    calls: () => i,
    lastMessages: () => messages,
  };
}

// The tsforge repo itself is the read-only workspace under test.
const REPO = join(import.meta.dir, "..", "..", "..");

// #63: every run below passes `tsService: null`. Without it, AgentRunner.run calls
// buildTsService(cwd) — building a TypeScript service over the ENTIRE tsforge repo (cwd: REPO) —
// which costs ~2s per test. In isolation that's tolerable, but under the full suite's concurrency
// the CPU contention inflated it past bun's 5000ms default and the tests spuriously timed out,
// false-BLOCKing the harness-review pre-validate gate. These read-only tests exercise tool-gating /
// events / maxTurns / abort / policy — none use the type-aware tools (type_at/diagnostics) — so a
// null service is faithful AND removes the cost at the ROOT, keeping every test well under the 5s
// fail-fast default (no timeout raise needed). Matches the many sibling tests that pass tsService: null.

describe("AgentRunner (read-only loop against this repo)", () => {
  test("tool turn then final text; events are agentId-tagged", async () => {
    const { provider } = scripted([
      {
        content: "",
        toolCalls: [
          { id: "1", name: "read", arguments: { file: "package.json" } },
        ],
      },
      { content: "The package is @agjs/tsforge.", toolCalls: [] },
    ]);
    const runner = new AgentRunner({ id: "explore" });
    const result = await runner.run({
      provider,
      cwd: REPO,
      tsService: null,
      parentTaskId: "run-1",
      task: "What package is this?",
    });

    expect(result.status).toBe("done");
    expect(result.output).toContain("@agjs/tsforge");
    expect(result.turns).toBe(2);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((e) => e.agentId === "run-1:explore")).toBe(
      true
    );
    expect(result.events.every((e) => e.parentTask === "run-1")).toBe(true);
  });

  test("mutating tools are neither advertised nor executable", async () => {
    const target = join(REPO, "SHOULD_NEVER_EXIST.ts");
    const { provider, seenTools } = scripted([
      {
        content: "",
        toolCalls: [
          {
            id: "1",
            name: "create",
            arguments: { file: "SHOULD_NEVER_EXIST.ts", content: "x" },
          },
        ],
      },
      { content: "done", toolCalls: [] },
    ]);
    const result = await new AgentRunner({ id: "explore" }).run({
      provider,
      cwd: REPO,
      tsService: null,
      parentTaskId: "run-1",
      task: "try to write",
    });

    // Layer 1: create/edit/run never advertised — nor spawn_agent, so a subagent
    // structurally cannot delegate (recursion depth capped at 1).
    expect(seenTools()).not.toContain("create");
    expect(seenTools()).not.toContain("edit_lines");
    expect(seenTools()).not.toContain("spawn_agent");
    expect(seenTools()).toContain("read");
    // Layer 2: the forced call was rejected at dispatch — nothing on disk.
    expect(existsSync(target)).toBe(false);
    expect(result.status).toBe("done");
  });

  test("spec.tools narrows the advertised read-only set", async () => {
    const { provider, seenTools } = scripted([
      { content: "ok", toolCalls: [] },
    ]);

    await new AgentRunner({ id: "narrow", tools: ["read"] }).run({
      provider,
      cwd: REPO,
      tsService: null,
      parentTaskId: "r",
      task: "t",
    });

    expect(seenTools()).toEqual(["read"]);
  });

  test("maxTurns cap SALVAGES the transcript instead of returning empty", async () => {
    // Repeats a read-call forever — even on the finalization call (a realistic
    // model-failure shape). The old code returned output "" here; the digest
    // must carry the tool evidence instead.
    const { provider, calls } = scripted([
      {
        content: "",
        toolCalls: [
          { id: "1", name: "read", arguments: { file: "package.json" } },
        ],
      },
    ]);
    const result = await new AgentRunner({ id: "loopy", maxTurns: 3 }).run({
      provider,
      cwd: REPO,
      tsService: null,
      parentTaskId: "r",
      task: "loop forever",
    });

    expect(result.status).toBe("max_turns");
    expect(result.turns).toBe(3);
    expect(result.outputKind).toBe("salvage");
    expect(result.output).toContain("Transcript digest");
    expect(result.output).toContain("[read]");
    // 3 loop turns + 1 finalization attempt.
    expect(calls()).toBe(4);
    expect(AGENT_LIMITS.maxTurns).toBeGreaterThan(0);
  });

  test("cap-hit finalization: tools stripped, FINAL TURN injected, partial findings returned", async () => {
    const readCall: IModelResponse = {
      content: "",
      toolCalls: [
        { id: "1", name: "read", arguments: { file: "package.json" } },
      ],
    };
    let finalRequestMessages: IChatMessage[] = [];
    let finalRequestTools: string[] = [];
    // Investigates every loop turn; answers ONLY when the toolset has been
    // stripped to agent_result alone (the finalization call).
    const provider: IProvider = {
      complete(msgs, opts) {
        const names = (opts?.tools ?? []).flatMap((t) =>
          typeof t === "object" &&
          t !== null &&
          "function" in t &&
          typeof t.function === "object" &&
          t.function !== null &&
          "name" in t.function &&
          typeof t.function.name === "string"
            ? [t.function.name]
            : []
        );

        if (names.length === 1 && names[0] === "agent_result") {
          finalRequestMessages = [...msgs];
          finalRequestTools = names;

          return Promise.resolve({
            content: "",
            toolCalls: [
              {
                id: "f",
                name: "agent_result",
                arguments: { summary: "partial: X confirmed", findings: [] },
              },
            ],
          });
        }

        return Promise.resolve(readCall);
      },
    };
    const result = await new AgentRunner({
      id: "capped",
      outputMode: "structured",
      maxTurns: 4,
    }).run({
      provider,
      cwd: REPO,
      tsService: null,
      parentTaskId: "r",
      task: "investigate",
    });

    expect(result.status).toBe("max_turns");
    expect(result.outputKind).toBe("answer");
    expect(result.turns).toBe(4);
    expect(result.output).toContain("partial: X confirmed");
    expect(finalRequestTools).toEqual(["agent_result"]);
    // The wrap-up instruction is the last user message of the final request…
    expect(finalRequestMessages.at(-1)?.content).toBe(
      AGENT_FINAL_TURN_STRUCTURED
    );
    // …the opening budget line and the countdown nudge were both injected…
    expect(
      finalRequestMessages.some((m) =>
        m.content.includes("[budget] You have 4 investigation turns")
      )
    ).toBe(true);
    expect(
      finalRequestMessages.some((m) =>
        m.content.includes("[budget] 2 turns left")
      )
    ).toBe(true);
  });

  test("text-mode finalization accepts prose with zero tools offered", async () => {
    const readCall: IModelResponse = {
      content: "",
      toolCalls: [
        { id: "1", name: "read", arguments: { file: "package.json" } },
      ],
    };
    let finalToolCount = -1;
    let sawFinalTurnText = false;
    const provider: IProvider = {
      complete(msgs, opts) {
        if (msgs.at(-1)?.content === AGENT_FINAL_TURN_TEXT) {
          sawFinalTurnText = true;
          finalToolCount = (opts?.tools ?? []).length;

          return Promise.resolve({
            content: "Findings so far: the package is @agjs/tsforge.",
            toolCalls: [],
          });
        }

        return Promise.resolve(readCall);
      },
    };
    const result = await new AgentRunner({ id: "texty", maxTurns: 2 }).run({
      provider,
      cwd: REPO,
      tsService: null,
      parentTaskId: "r",
      task: "investigate",
    });

    expect(result.status).toBe("max_turns");
    expect(result.outputKind).toBe("answer");
    expect(result.output).toContain("@agjs/tsforge");
    expect(sawFinalTurnText).toBe(true);
    expect(finalToolCount).toBe(0);
  });

  test("structured mode: agent_result before investigating is rejected, accepted after a real tool call", async () => {
    const { provider, seenTools } = scripted([
      // Turn 1: tries to answer immediately. `agent_result` alone satisfies
      // toolChoice:"required", but with real tools available and no investigation
      // yet it MUST be rejected (else a structured agent answers from memory).
      {
        content: "",
        toolCalls: [
          { id: "1", name: "agent_result", arguments: { result: "premature" } },
        ],
      },
      // Turn 2: forced to actually investigate.
      {
        content: "",
        toolCalls: [
          { id: "2", name: "read", arguments: { file: "package.json" } },
        ],
      },
      // Turn 3: now the result is accepted.
      {
        content: "",
        toolCalls: [
          { id: "3", name: "agent_result", arguments: { result: "grounded" } },
        ],
      },
    ]);
    const result = await new AgentRunner({
      id: "structured",
      outputMode: "structured",
    }).run({
      provider,
      cwd: REPO,
      tsService: null,
      parentTaskId: "r",
      task: "t",
    });

    expect(seenTools()).toContain("agent_result");
    expect(result.status).toBe("done");
    // The premature turn-1 answer was NOT accepted; the grounded one (after a
    // real read) was.
    expect(result.output).toBe("grounded");
    expect(result.turns).toBe(3);
  });

  test("structured agent with NO real tools accepts agent_result immediately", async () => {
    const { provider } = scripted([
      {
        content: "",
        toolCalls: [
          { id: "1", name: "agent_result", arguments: { result: "answer" } },
        ],
      },
    ]);
    // `tools: []` ⇒ the only advertised tool is agent_result, so there's nothing
    // to investigate WITH — the investigation gate must not deadlock it.
    const result = await new AgentRunner({
      id: "structured",
      outputMode: "structured",
      tools: [],
    }).run({
      provider,
      cwd: REPO,
      tsService: null,
      parentTaskId: "r",
      task: "t",
    });

    expect(result.status).toBe("done");
    expect(result.output).toBe("answer");
    expect(result.turns).toBe(1);
  });

  test("generate kind is rejected until Phase D", async () => {
    const { provider } = scripted([{ content: "", toolCalls: [] }]);
    const result = await new AgentRunner({ id: "img", kind: "generate" }).run({
      provider,
      cwd: REPO,
      tsService: null,
      parentTaskId: "r",
    });

    expect(result.status).toBe("error");
    expect(result.output).toContain("generate");
  });
});

describe("review-round regressions", () => {
  test("project policy rules apply inside the agent (deny read)", async () => {
    const { provider } = scripted([
      {
        content: "",
        toolCalls: [
          { id: "1", name: "read", arguments: { file: "package.json" } },
        ],
      },
      { content: "blocked, giving up", toolCalls: [] },
    ]);
    const result = await new AgentRunner({ id: "explore" }).run({
      provider,
      cwd: REPO,
      tsService: null,
      parentTaskId: "r",
      task: "read the manifest",
      policyMode: "default",
      policyRules: { deny: [{ toolName: "read" }] },
    });

    // The deny rule fired at dispatch: a rejection event, no file content.
    expect(
      result.events.some((e) => e.message.startsWith("tool_rejected"))
    ).toBe(true);
    expect(result.status).toBe("done");
  });

  test("mid-request abort reports aborted + the true turn count", async () => {
    const ctrl = new AbortController();
    const aborting: IProvider = {
      complete() {
        ctrl.abort();

        const err = new Error("The operation was aborted.");

        err.name = "AbortError";

        return Promise.reject(err);
      },
    };
    const result = await new AgentRunner({ id: "explore" }).run({
      provider: aborting,
      cwd: REPO,
      tsService: null,
      parentTaskId: "r",
      task: "t",
      signal: ctrl.signal,
    });

    expect(result.status).toBe("aborted");
    expect(result.turns).toBe(1); // not maxTurns
    // Abort skips finalization but still never returns empty.
    expect(result.output).toBe(NO_SALVAGE_FALLBACK);
    expect(result.outputKind).toBe("salvage");
  });

  test("error path carries the exception message AND the transcript digest", async () => {
    let call = 0;
    const provider: IProvider = {
      complete() {
        call += 1;

        if (call === 1) {
          return Promise.resolve({
            content: "",
            toolCalls: [
              { id: "1", name: "read", arguments: { file: "package.json" } },
            ],
          });
        }

        return Promise.reject(new Error("boom 503"));
      },
    };
    const result = await new AgentRunner({ id: "explode" }).run({
      provider,
      cwd: REPO,
      tsService: null,
      parentTaskId: "r",
      task: "t",
    });

    expect(result.status).toBe("error");
    expect(result.outputKind).toBe("salvage");
    // The reason used to live only in the event stream — now it is the output…
    expect(result.output).toContain("boom 503");
    // …together with the evidence gathered before the crash.
    expect(result.output).toContain("[read]");
  });

  test("declared-but-gated-off toolset fails fast with the reason (no turn burn)", async () => {
    const prevWeb = process.env.TSFORGE_WEB;

    delete process.env.TSFORGE_WEB;

    try {
      const { provider, calls } = scripted([{ content: "", toolCalls: [] }]);
      const result = await new AgentRunner({
        id: "webby",
        outputMode: "structured",
        tools: ["web_search", "web_fetch"],
      }).run({
        provider,
        cwd: REPO,
        tsService: null,
        parentTaskId: "r",
        task: "t",
      });

      expect(result.status).toBe("error");
      expect(result.turns).toBe(0);
      expect(result.output).toContain("TSFORGE_WEB");
      expect(result.output).toContain("web_search");
      // No model calls were burned discovering the toolset is empty.
      expect(calls()).toBe(0);
    } finally {
      if (prevWeb === undefined) {
        delete process.env.TSFORGE_WEB;
      } else {
        process.env.TSFORGE_WEB = prevWeb;
      }
    }
  });

  test("partially gated toolset injects a harness availability note up front", async () => {
    const prevWeb = process.env.TSFORGE_WEB;

    delete process.env.TSFORGE_WEB;

    try {
      const { provider, lastMessages } = scripted([
        { content: "ok", toolCalls: [] },
      ]);
      const result = await new AgentRunner({
        id: "degraded",
        tools: ["web_search", "read"],
      }).run({
        provider,
        cwd: REPO,
        tsService: null,
        parentTaskId: "r",
        task: "t",
      });

      expect(result.status).toBe("done");

      const task = lastMessages().find((m) => m.role === "user")?.content ?? "";

      expect(task).toContain("[harness note]");
      expect(task).toContain("web_search");
      // The opening budget line rides the same task message.
      expect(task).toContain("[budget] You have");
    } finally {
      if (prevWeb === undefined) {
        delete process.env.TSFORGE_WEB;
      } else {
        process.env.TSFORGE_WEB = prevWeb;
      }
    }
  });

  test("tools: [] means NO tools, not the full read-only set", async () => {
    const { parseAgentSpec: parse } = await import("../src/config/agent-specs");

    expect(parse({ id: "x", tools: [] })?.tools).toEqual([]);

    const { provider, seenTools } = scripted([
      { content: "ok", toolCalls: [] },
    ]);

    await new AgentRunner({ id: "bare", tools: [] }).run({
      provider,
      cwd: REPO,
      tsService: null,
      parentTaskId: "r",
      task: "t",
    });

    expect(seenTools()).toEqual([]);
  });

  test("a throwing caller reporter cannot kill the run", async () => {
    const { provider } = scripted([{ content: "fine", toolCalls: [] }]);
    const result = await new AgentRunner({ id: "x" }).run({
      provider,
      cwd: REPO,
      tsService: null,
      parentTaskId: "r",
      task: "t",
      report: () => {
        throw new Error("consumer bug");
      },
    });

    expect(result.status).toBe("done");
    expect(result.output).toBe("fine");
  });
});
