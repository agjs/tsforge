import { test, expect } from "bun:test";
import { judge } from "../src/eval";
import type { IProvider } from "../src/inference";

function providerSaying(content: string): IProvider {
  return {
    async complete() {
      return { content, toolCalls: [] };
    },
  };
}

test("parses a JSON quality score from the reviewer", async () => {
  const provider = providerSaying(
    JSON.stringify({
      overall: 4,
      correctness: 5,
      design: 4,
      readability: 3,
      notes: "solid, minor naming nits",
    })
  );

  const s = await judge(provider, { goal: "g", criteria: "c", code: "x" });

  expect(s.overall).toBe(4);
  expect(s.correctness).toBe(5);
  expect(s.readability).toBe(3);
  expect(s.notes).toContain("solid");
});

test("tolerates a fenced JSON block", async () => {
  const provider = providerSaying(
    'Here is my review:\n```json\n{"overall":2,"correctness":2,"design":2,"readability":2,"notes":"weak"}\n```\n'
  );

  const s = await judge(provider, { goal: "g", criteria: "c", code: "x" });

  expect(s.overall).toBe(2);
});

test("falls back gracefully on an unparseable response", async () => {
  const s = await judge(providerSaying("no json here"), {
    goal: "g",
    criteria: "c",
    code: "x",
  });

  expect(s.overall).toBe(0);
  expect(s.notes.toLowerCase()).toContain("unparseable");
});
