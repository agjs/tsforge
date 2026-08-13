import { test, expect, describe } from "bun:test";
import type { IChatMessage, IProvider } from "../src/inference";
import {
  compactConversation,
  compactSummaryLine,
  pruneOversizedToolResults,
  PRUNE_MARKER,
  PRUNE_THRESHOLD_CHARS,
} from "../src/loop/context-hygiene";

/** Records how many times the summarizer was asked to run. */
function countingProvider(): { provider: IProvider; calls: () => number } {
  let calls = 0;

  return {
    provider: {
      async complete() {
        calls += 1;

        return { content: "brief summary", toolCalls: [] };
      },
    },
    calls: () => calls,
  };
}

/** Fails the test if compaction reaches the model at all. */
const refusingProvider: IProvider = {
  async complete() {
    throw new Error("summarizer must not be called");
  },
};

/** A step whose assistant turn is far too large to fit in the retain budget,
 *  so the budget cut lands on its tool RESULT and the pair must be re-joined. */
function historyCutMidStep(): IChatMessage[] {
  return [
    { role: "system", content: "sys" },
    {
      role: "assistant",
      content: "old",
      toolCalls: [{ id: "c1", name: "read", arguments: {} }],
    },
    { role: "tool", content: "old result", toolCallId: "c1" },
    {
      role: "assistant",
      content: "A".repeat(100_000),
      toolCalls: [{ id: "c2", name: "read", arguments: {} }],
    },
    { role: "tool", content: "fresh result", toolCallId: "c2" },
  ];
}

/** Every retained tool result still has the assistant turn that declared it. */
function hasNoOrphanToolResult(messages: readonly IChatMessage[]): boolean {
  const declared = new Set<string>();

  for (const m of messages) {
    for (const call of m.role === "assistant" ? (m.toolCalls ?? []) : []) {
      if (call.id !== undefined) {
        declared.add(call.id);
      }
    }

    if (
      m.role === "tool" &&
      m.toolCallId !== undefined &&
      !declared.has(m.toolCallId)
    ) {
      return false;
    }
  }

  return true;
}

describe("compaction retain window", () => {
  test("keeps the newest turns verbatim instead of wiping the history", async () => {
    const { provider } = countingProvider();
    const messages = historyCutMidStep();

    const result = await compactConversation(messages, provider);
    const kept = result.messages.map((m) => m.content);

    expect(kept).toContain("fresh result");
    expect(kept.some((c) => c.includes("brief summary"))).toBe(true);
    // The summarized turn is gone; only the retained tail survives verbatim.
    expect(kept).not.toContain("old result");
  });

  test("never retains a tool result whose declaring turn was summarized away", async () => {
    const { provider } = countingProvider();

    const result = await compactConversation(historyCutMidStep(), provider);

    expect(hasNoOrphanToolResult(result.messages)).toBe(true);
    // The pair was re-joined rather than dropped: both halves are present.
    const kept = result.messages.map((m) => m.content);

    expect(kept).toContain("fresh result");
    expect(kept.some((c) => c.startsWith("A".repeat(100)))).toBe(true);
  });

  test("orders output as system, summary, then the retained tail", async () => {
    const { provider } = countingProvider();

    const result = await compactConversation(historyCutMidStep(), provider);
    const [first, second] = result.messages;

    expect(first?.role).toBe("system");
    expect(first?.content).toBe("sys");
    expect(second?.content).toContain("brief summary");
    expect(result.messages.at(-1)?.content).toBe("fresh result");
  });

  test("drops an already-orphaned tool result rather than retaining it", async () => {
    const { provider } = countingProvider();
    const messages: IChatMessage[] = [
      { role: "user", content: "U".repeat(100_000) },
      { role: "tool", content: "leftover", toolCallId: "ghost" },
    ];

    const result = await compactConversation(messages, provider);

    expect(hasNoOrphanToolResult(result.messages)).toBe(true);
    expect(result.messages.some((m) => m.role === "tool")).toBe(false);
  });
});

describe("prune before summarize", () => {
  test("a big enough prune replaces the summary call entirely", async () => {
    const messages: IChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "run", arguments: {} }],
      },
      { role: "tool", content: "X".repeat(50_000), toolCallId: "c1" },
    ];

    const result = await compactConversation(messages, refusingProvider);

    expect(result.prunedChars).toBeGreaterThan(0);
    expect(result.after).toBe(result.before);
    expect(result.messages.at(-1)?.content).toContain(PRUNE_MARKER);
  });

  test("a prune that frees too little still summarizes in the same compact", async () => {
    const { provider, calls } = countingProvider();
    const messages: IChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "U".repeat(200_000) },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "run", arguments: {} }],
      },
      { role: "tool", content: "X".repeat(10_000), toolCallId: "c1" },
    ];

    const result = await compactConversation(messages, provider);

    expect(calls()).toBe(1);
    expect(result.prunedChars).toBeUndefined();
    expect(
      result.messages.some((m) => m.content.includes("brief summary"))
    ).toBe(true);
  });

  test("pruning is spent after one pass", () => {
    const messages: IChatMessage[] = [
      { role: "tool", content: "X".repeat(50_000), toolCallId: "c1" },
    ];

    const first = pruneOversizedToolResults(messages);
    const second = pruneOversizedToolResults(messages);

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  test("leaves results at or under the threshold untouched", () => {
    const content = "X".repeat(PRUNE_THRESHOLD_CHARS);
    const messages: IChatMessage[] = [
      { role: "tool", content, toolCallId: "c1" },
    ];

    expect(pruneOversizedToolResults(messages)).toBe(0);
    expect(messages[0]?.content).toBe(content);
  });
});

describe("compactSummaryLine", () => {
  test("reports freed bytes when no summary was written", () => {
    expect(
      compactSummaryLine({ before: 40, after: 40, prunedChars: 51_200 })
    ).toBe("pruned 50KB of tool output — no summary needed");
  });

  test("reports the message count when a summary was written", () => {
    expect(compactSummaryLine({ before: 40, after: 3 })).toBe(
      "compacted 40 → 3 messages"
    );
  });
});
