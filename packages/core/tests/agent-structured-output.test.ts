import { describe, expect, test } from "bun:test";
import { AgentRunner } from "../src/agent";
import { BUILTIN_SPECS } from "../src/agent/builtin-specs";
import type { IAgentSpec } from "../src/agent/agent-spec";
import type { IProvider, IChatMessage, IModelResponse } from "../src/inference";

// A no-tools structured spec: the runner accepts an agent_result call
// immediately (nothing to investigate), so one scripted response drives it.
const SPEC: IAgentSpec = {
  id: "test-structured",
  description: "t",
  systemPrompt: "investigate",
  tools: [],
  outputMode: "structured",
};

function runWith(res: IModelResponse): ReturnType<AgentRunner["run"]> {
  const provider: IProvider = {
    complete: (_m: IChatMessage[]) => Promise.resolve(res),
  };

  return new AgentRunner(SPEC).run({
    provider,
    cwd: process.cwd(),
    parentTaskId: "t",
    task: "explore",
    tsService: null,
    policyMode: "bypassPermissions",
  });
}

const resultCall = (args: Record<string, unknown>): IModelResponse => ({
  content: "",
  toolCalls: [{ name: "agent_result", arguments: args }],
});

describe("structured agent_result output", () => {
  test("formats summary + cited findings into readable text", async () => {
    const r = await runWith(
      resultCall({
        summary: "The gate runs `bun run` and reads the exit code.",
        findings: [
          {
            detail: "exit 0 = pass",
            source: "core-gate.ts:80",
            confidence: "high",
          },
          {
            detail: "GATE_SKIP bypasses the command",
            source: "core-gate.ts:44",
          },
        ],
      })
    );

    expect(r.status).toBe("done");
    expect(r.output).toContain("The gate runs `bun run`");
    expect(r.output).toContain("- exit 0 = pass (core-gate.ts:80) [high]");
    expect(r.output).toContain(
      "- GATE_SKIP bypasses the command (core-gate.ts:44)"
    );
  });

  test("a finding with no detail is dropped (never a bare bullet)", async () => {
    const r = await runWith(
      resultCall({
        summary: "S",
        findings: [{ source: "x.ts:1" }, { detail: "real point" }],
      })
    );

    expect(r.output).toBe("S\n- real point");
  });

  test("falls back to a legacy { result } string", async () => {
    const r = await runWith(resultCall({ result: "plain legacy answer" }));

    expect(r.output).toBe("plain legacy answer");
  });

  test("all built-in specs request structured output", () => {
    expect(BUILTIN_SPECS.length).toBeGreaterThan(0);

    for (const s of BUILTIN_SPECS) {
      expect(s.outputMode).toBe("structured");
    }
  });
});
