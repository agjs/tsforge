import { test, expect } from "bun:test";
import { buildSalvageDigest, NO_SALVAGE_FALLBACK } from "../src/agent/salvage";
import type { IChatMessage } from "../src/inference";

function assistantCall(id: string, name: string): IChatMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [{ id, name, arguments: {} }],
  };
}

test("digests prose, tool previews and compaction summaries in order", () => {
  const messages: IChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    {
      role: "user",
      content: "[Summary of the investigation so far]\nEarlier: A imports B.",
    },
    { role: "assistant", content: "Poly Pizza has a documented API." },
    assistantCall("c1", "web_fetch"),
    { role: "tool", toolCallId: "c1", content: "API docs body …" },
  ];
  const digest = buildSalvageDigest(messages);

  expect(digest).toContain("Transcript digest");
  expect(digest).toContain("[Summary of the investigation so far]");
  expect(digest).toContain("Poly Pizza has a documented API.");
  expect(digest).toContain("[web_fetch] API docs body …");
});

test("keeps only the LAST 6 prose fragments and caps each at 500 chars", () => {
  const messages: IChatMessage[] = Array.from({ length: 9 }, (_, i) => ({
    role: "assistant" as const,
    content: `fragment-${i} ${"x".repeat(600)}`,
  }));
  const digest = buildSalvageDigest(messages);

  expect(digest).not.toContain("fragment-2 ");
  expect(digest).toContain("fragment-3 ");
  expect(digest).toContain("fragment-8 ");
  // The 600-char body was capped (marker appended).
  expect(digest).toContain("…");
});

test("keeps only the LAST 4 tool previews and excludes agent_result nudges", () => {
  const messages: IChatMessage[] = [];

  for (let i = 0; i < 6; i += 1) {
    messages.push(assistantCall(`c${i}`, "read"));
    messages.push({
      role: "tool",
      toolCallId: `c${i}`,
      content: `result-${i}`,
    });
  }

  messages.push(assistantCall("r", "agent_result"));
  messages.push({
    role: "tool",
    toolCallId: "r",
    content: "Investigate FIRST",
  });

  const digest = buildSalvageDigest(messages);

  expect(digest).not.toContain("result-0");
  expect(digest).not.toContain("result-1");
  expect(digest).toContain("[read] result-2");
  expect(digest).toContain("[read] result-5");
  expect(digest).not.toContain("Investigate FIRST");
});

test("total digest is hard-capped at 4000 chars", () => {
  const messages: IChatMessage[] = Array.from({ length: 6 }, () => ({
    role: "assistant" as const,
    content: "y".repeat(500),
  }));

  messages.push({
    role: "user",
    content: `[Summary of the investigation so far]\n${"z".repeat(2_000)}`,
  });

  expect(buildSalvageDigest(messages).length).toBeLessThanOrEqual(4_000);
});

test("nothing salvageable → empty string (callers substitute the fallback)", () => {
  const messages: IChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    { role: "assistant", content: "   " },
  ];

  expect(buildSalvageDigest(messages)).toBe("");
  expect(NO_SALVAGE_FALLBACK.length).toBeGreaterThan(0);
});
