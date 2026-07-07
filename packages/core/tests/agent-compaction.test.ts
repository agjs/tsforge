import { describe, expect, test } from "bun:test";
import { AgentRunner } from "../src/agent";
import type { IAgentSpec } from "../src/agent/agent-spec";
import type {
  IProvider,
  ICompleteOptions,
  IModelResponse,
  IChatMessage,
} from "../src/inference";
import { COMPACT_SYSTEM } from "../src/loop/prompt";
import type { ILoopEvent } from "../src/loop";

// Must exceed the 16384-token output reserve the runner subtracts to get the
// effective prompt budget (effectiveWindow = WINDOW - 16384 = 83616; the
// compaction threshold is 0.8 of that ≈ 66893).
const WINDOW = 100_000;

// A scripted provider: NON-compaction calls consume `script` in order (an entry
// is either a response or an Error to throw); a compaction call (system ===
// COMPACT_SYSTEM) returns a fixed summary and is counted separately.
class ScriptedProvider implements IProvider {
  compactionCalls = 0;
  normalCalls = 0;

  constructor(private readonly script: (IModelResponse | Error)[]) {}

  complete(
    messages: IChatMessage[],
    _opts?: ICompleteOptions
  ): Promise<IModelResponse> {
    if (messages[0]?.content === COMPACT_SYSTEM) {
      this.compactionCalls += 1;

      return Promise.resolve({
        content: "SUMMARY of findings so far",
        toolCalls: [],
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      });
    }

    const next = this.script[this.normalCalls];

    this.normalCalls += 1;

    if (next instanceof Error) {
      return Promise.reject(next);
    }

    if (next === undefined) {
      return Promise.resolve({ content: "done", toolCalls: [] });
    }

    return Promise.resolve(next);
  }
}

const answer = (content: string, promptTokens: number): IModelResponse => ({
  content,
  toolCalls: [],
  usage: { promptTokens, completionTokens: 5, totalTokens: promptTokens + 5 },
});

// A no-tools spec: the runner accepts a non-empty text answer as the final
// result, and an empty answer nudges for another turn — enough to drive ≥2 turns
// deterministically without executing real tools.
const SPEC: IAgentSpec = {
  id: "test-explore",
  description: "test",
  systemPrompt: "investigate",
  tools: [],
};

async function run(
  provider: IProvider
): Promise<{ status: string; output: string; events: ILoopEvent[] }> {
  return new AgentRunner(SPEC).run({
    provider,
    cwd: process.cwd(),
    parentTaskId: "t",
    task: "explore the thing",
    contextWindow: WINDOW,
    tsService: null,
    policyMode: "bypassPermissions",
  });
}

const compacted = (events: ILoopEvent[]): ILoopEvent[] =>
  events.filter((e) => e.message.includes("↯ compacted"));

describe("AgentRunner auto-compaction", () => {
  test("PROACTIVE: compacts before the next turn once prompt tokens cross the window fraction", async () => {
    // Turn 1: empty answer (→ nudge, another turn) but reports promptTokens at
    // 90% of the window. Before turn 2 the runner must compact.
    const provider = new ScriptedProvider([
      answer("", 90_000), // turn 1: above the effective-budget threshold (~66893)
      answer("final answer", 30), // turn 2 (post-compaction): finishes
    ]);

    const { status, output, events } = await run(provider);

    expect(provider.compactionCalls).toBe(1);
    expect(compacted(events).length).toBe(1);
    expect(status).toBe("done");
    expect(output).toBe("final answer");
  });

  test("does NOT compact while prompt tokens stay under the fraction", async () => {
    const provider = new ScriptedProvider([
      answer("", 20_000), // turn 1: well under the threshold
      answer("final answer", 40), // turn 2
    ]);

    const { status, events } = await run(provider);

    expect(provider.compactionCalls).toBe(0);
    expect(compacted(events).length).toBe(0);
    expect(status).toBe("done");
  });

  test("REACTIVE: a context-overflow rejection is recovered by compacting and retrying", async () => {
    // Turn 1 finishes empty (low tokens, no proactive compaction) → history grows
    // to >2 messages. Turn 2 the request OVERFLOWS; the runner compacts and
    // retries the same turn, which then succeeds.
    const provider = new ScriptedProvider([
      answer("", 50), // turn 1: low tokens, nudge
      new Error(
        "model request failed: 400 This model's maximum context length is 1000 tokens. However, you requested 1200 tokens."
      ), // turn 2: overflow
      answer("recovered answer", 60), // turn 2 retry after compaction
    ]);

    const { status, output, events } = await run(provider);

    expect(provider.compactionCalls).toBe(1);
    expect(
      compacted(events).some((e) => e.message.includes("recovering"))
    ).toBe(true);
    expect(status).toBe("done");
    expect(output).toBe("recovered answer");
  });

  test("a non-overflow provider error is NOT swallowed (still an error)", async () => {
    const provider = new ScriptedProvider([
      new Error("model request failed: 500 internal server error"),
    ]);

    const { status } = await run(provider);

    expect(provider.compactionCalls).toBe(0);
    expect(status).toBe("error");
  });
});
