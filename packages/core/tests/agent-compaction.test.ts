import { describe, expect, test } from "bun:test";
import { AgentRunner } from "../src/agent";
import {
  buildBoundedTranscript,
  isContextOverflow,
} from "../src/agent/agent-runner";
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

  test("REACTIVE recovery works even when the context window is UNKNOWN (bounded fallback)", async () => {
    // No contextWindow → the reactive path must still bound the summarizer input
    // (fixed fallback), not build an unbounded transcript that overflows again.
    const provider = new ScriptedProvider([
      answer("", 50), // turn 1: nudge, history grows past 2 messages
      new Error("model request failed: 400 maximum context length exceeded"), // turn 2: overflow
      answer("recovered", 60), // retry after bounded compaction
    ]);

    const result = await new AgentRunner(SPEC).run({
      provider,
      cwd: process.cwd(),
      parentTaskId: "t",
      task: "explore",
      tsService: null,
      policyMode: "bypassPermissions",
      // contextWindow deliberately omitted (window = 0)
    });

    expect(provider.compactionCalls).toBe(1);
    expect(result.status).toBe("done");
    expect(result.output).toBe("recovered");
  });

  test("a non-overflow provider error is NOT swallowed (still an error)", async () => {
    const provider = new ScriptedProvider([
      new Error("model request failed: 500 internal server error"),
    ]);

    const { status } = await run(provider);

    expect(provider.compactionCalls).toBe(0);
    expect(status).toBe("error");
  });

  // A small model (window ≤ the output reserve) must not collapse the effective
  // budget to ~0 and compact on every turn (the reviewer's infinite-loop case).
  test("a small context window does NOT trigger compaction every turn", async () => {
    const result = await new AgentRunner(SPEC).run({
      provider: new ScriptedProvider([
        answer("", 2000), // ~25% of an 8k window — well under any sane threshold
        answer("final answer", 2000),
      ]),
      cwd: process.cwd(),
      parentTaskId: "t",
      task: "explore",
      contextWindow: 8000, // < the 16384 output reserve
      tsService: null,
      policyMode: "bypassPermissions",
    });

    expect(result.status).toBe("done");
    expect(compacted(result.events).length).toBe(0);
  });
});

describe("isContextOverflow", () => {
  test("matches vLLM/OpenAI context-overflow messages", () => {
    expect(
      isContextOverflow(
        new Error(
          "400 This model's maximum context length is 131072 tokens. However, you requested 131073."
        )
      )
    ).toBe(true);
    expect(
      isContextOverflow(new Error("reduce the length of the messages"))
    ).toBe(true);
  });

  test("extracts the message from a non-Error object (nested error.message)", () => {
    expect(
      isContextOverflow({
        error: { message: "maximum context length exceeded" },
      })
    ).toBe(true);
    expect(isContextOverflow({ message: "context window is full" })).toBe(true);
  });

  test("is false for unrelated errors", () => {
    expect(isContextOverflow(new Error("500 internal server error"))).toBe(
      false
    );
    expect(isContextOverflow(null)).toBe(false);
    expect(isContextOverflow("timed out")).toBe(false);
  });
});

describe("buildBoundedTranscript", () => {
  const msg = (role: string, content: string) => ({ role, content });

  test("always includes the newest message, truncating it if it alone exceeds the budget", () => {
    const huge = "Z".repeat(5000);
    const out = buildBoundedTranscript(
      [msg("user", "task"), msg("assistant", "a"), msg("tool", huge)],
      500
    );

    expect(out).toContain("[tool]"); // the newest message is present…
    expect(out).toContain("…[truncated]"); // …truncated to fit
    expect(out.length).toBeLessThanOrEqual(500); // bound respected
  });

  test("elides older messages with a marker and stays within the budget", () => {
    const conversation = Array.from({ length: 20 }, (_v, i) =>
      msg("tool", `finding ${i} `.repeat(20))
    );
    const out = buildBoundedTranscript(conversation, 400);

    expect(out).toContain("earlier message(s) elided");
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out).toContain("finding 19"); // newest kept
  });

  test("MANY short messages stay within budget (join separators counted)", () => {
    // 200 tiny messages: without counting the "\n\n" separators, the aggregate
    // would blow past a small maxChars even though each message is trivial.
    const conversation = Array.from({ length: 200 }, (_v, i) =>
      msg("user", `m${i}`)
    );
    const out = buildBoundedTranscript(conversation, 300);

    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain("m199"); // newest kept
  });

  test("maxChars ≤ 0 means unbounded (returns the full transcript)", () => {
    const out = buildBoundedTranscript(
      [msg("user", "one"), msg("assistant", "two")],
      0
    );

    expect(out).toBe("[user] one\n\n[assistant] two");
  });

  test("output NEVER exceeds maxChars for ANY maxChars 1..400 (incl. below the marker reserve)", () => {
    const convo = [
      msg("user", "a".repeat(500)),
      msg("assistant", "b".repeat(500)),
      msg("tool", "c".repeat(50)),
      msg("user", "short"),
    ];

    for (let mc = 1; mc <= 400; mc += 1) {
      expect(buildBoundedTranscript(convo, mc).length).toBeLessThanOrEqual(mc);
    }
  });

  test("UTF-16 surrogate pairs are never split at maxChars boundary", () => {
    // Emoji like 😀 use 2 UTF-16 code units. If we slice at the exact boundary,
    // we'd split the pair and emit garbage. The safe-slice logic checks if the
    // last char is a high surrogate (0xD800–0xDBFF) and drops it.
    const text = "text with emoji " + "😀".repeat(10); // Construct so slice could hit mid-pair
    const convo = [msg("user", text)];

    // Slice at a position that might land in the middle of an emoji surrogate pair
    const result = buildBoundedTranscript(convo, 25); // Short maxChars forces hard-cap

    // Result must: (1) not exceed maxChars, (2) not have orphaned high surrogate at the end
    expect(result.length).toBeLessThanOrEqual(25);

    // Check that we didn't emit a high surrogate as the last character
    const lastCharCode = result.charCodeAt(result.length - 1);
    const isBrokenSurrogate = lastCharCode >= 0xd800 && lastCharCode <= 0xdbff;

    expect(isBrokenSurrogate).toBe(false);
  });
});
