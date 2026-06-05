import { test, expect } from "bun:test";
import { reviewTests } from "../src/spec/review-tests";
import type { IProvider } from "../src/inference/types";

// A judge that returns one canned response (JSON, optionally fenced).
function cannedJudge(content: string): IProvider {
  return {
    async complete() {
      return { content, toolCalls: [] };
    },
  };
}

const INPUT = {
  goal: "money",
  criteria: "allocate distributes remainder by largest fractional part",
  testCode:
    'test("x", () => { expect(allocate(100, [1,1,1])).toEqual([33,33,34]); });',
  moduleSpecifier: "./money",
};

test("parses findings and a corrected suite from the reviewer", async () => {
  const judge = cannedJudge(
    JSON.stringify({
      findings: [
        {
          test: "x",
          kind: "ambiguous",
          reason: "equal fractional parts leave the tie-break undefined",
        },
      ],
      correctedSuite:
        'test("x", () => { expect(allocate(100, [2,1])).toEqual([67,33]); });',
    })
  );

  const r = await reviewTests(judge, INPUT);

  expect(r.findings).toHaveLength(1);
  expect(r.findings[0]?.kind).toBe("ambiguous");
  expect(r.correctedSuite).toContain("[67,33]");
});

test("treats an empty correctedSuite as 'no changes needed'", async () => {
  const judge = cannedJudge(
    JSON.stringify({ findings: [], correctedSuite: "" })
  );

  const r = await reviewTests(judge, INPUT);

  expect(r.findings).toHaveLength(0);
  expect(r.correctedSuite).toBe("");
});

test("degrades safely on an unparseable reviewer response", async () => {
  const r = await reviewTests(cannedJudge("not json at all"), INPUT);

  expect(r.findings).toHaveLength(0);
  expect(r.correctedSuite).toBe("");
});

test("ignores malformed findings entries without throwing", async () => {
  const judge = cannedJudge(
    JSON.stringify({
      findings: [
        { test: "x", kind: "unsatisfiable", reason: "float" },
        42,
        null,
      ],
      correctedSuite: "",
    })
  );

  const r = await reviewTests(judge, INPUT);

  expect(r.findings).toHaveLength(1);
  expect(r.findings[0]?.test).toBe("x");
});
