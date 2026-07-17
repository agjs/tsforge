import { test, expect } from "bun:test";
import { assistantMessage } from "../src/loop/assistant-message";

test("keeps tool_calls and reasoningContent on a normal (non-aborted) response", () => {
  const msg = assistantMessage({
    content: "hi",
    toolCalls: [{ id: "a", name: "create", arguments: { path: "x" } }],
    reasoning: "because",
  });

  expect(msg.toolCalls).toHaveLength(1);
  expect(msg.content).toBe("hi");
  expect(msg.reasoningContent).toBe("because");
});

test("drops partial tool_calls on a TTSR abort, backfilling empty content", () => {
  const msg = assistantMessage({
    content: "",
    toolCalls: [{ id: "a", name: "create", arguments: { path: "x" } }],
    ttsrFired: { ruleName: "no-as-cast", guidance: "no as casts" },
  });

  expect(msg.toolCalls).toBeUndefined();
  expect(msg.content.length).toBeGreaterThan(0);
});

test("on a TTSR abort, PRESERVES non-empty content instead of the placeholder", () => {
  const msg = assistantMessage({
    content: "partial thought before the cast",
    toolCalls: [{ id: "a", name: "create", arguments: { path: "x" } }],
    ttsrFired: { ruleName: "no-as-cast", guidance: "no as casts" },
  });

  expect(msg.toolCalls).toBeUndefined();
  expect(msg.content).toBe("partial thought before the cast");
});

test("on a TTSR abort, still carries reasoningContent when present", () => {
  const msg = assistantMessage({
    content: "",
    toolCalls: [],
    reasoning: "chain of thought",
    ttsrFired: { ruleName: "no-as-cast", guidance: "no as casts" },
  });

  expect(msg.reasoningContent).toBe("chain of thought");
});
