import { test, expect } from "bun:test";
import { proposePlan, parsePlanJson } from "../src/loop/planning/propose-plan";
import type { IProvider } from "../src/inference";

const mockPlan = {
  product: "A bookmarking app.",
  slices: [
    {
      entity: {
        id: "Bookmark",
        desc: "a link",
        fields: [{ name: "url", type: "string" }],
        relationships: [],
        rules: [],
      },
      ui: {
        screens: ["list"],
        action: "save → list",
        shows: ["url"],
        nav: "Bookmarks",
      },
      verification: {
        mustRemainTrue: ["auth"],
        mustNotHappen: ["no url"],
        acceptanceCheck: "bun test",
      },
    },
  ],
};

test("proposePlan turns a product description into a structured plan", async () => {
  const planner: IProvider = {
    complete: async () => ({
      content: JSON.stringify(mockPlan),
      toolCalls: [],
    }),
  };

  const plan = await proposePlan(
    { planner },
    { description: "a bookmarking app" }
  );

  expect(plan?.slices[0]?.entity.id).toBe("Bookmark");
});

test("a non-JSON planner reply yields null", async () => {
  const bad: IProvider = {
    complete: async () => ({ content: "sorry", toolCalls: [] }),
  };

  expect(await proposePlan({ planner: bad }, { description: "x" })).toBeNull();
});

test("validation failure triggers retry with higher temperature, succeeding on second reply", async () => {
  let callCount = 0;
  const retryingPlanner: IProvider = {
    complete: async (_msgs, _opts) => {
      callCount++;

      if (callCount === 1) {
        // First call: return invalid JSON
        return { content: "not json at all", toolCalls: [] };
      }

      // Second call (higher temp): return valid plan
      return {
        content: JSON.stringify(mockPlan),
        toolCalls: [],
      };
    },
  };

  const plan = await proposePlan(
    { planner: retryingPlanner },
    { description: "test" }
  );

  expect(plan?.slices[0]?.entity.id).toBe("Bookmark");
  expect(callCount).toBe(2);
});

test("validation failure on both attempts yields null", async () => {
  let callCount = 0;
  const failingPlanner: IProvider = {
    complete: async () => {
      callCount++;

      return { content: "never valid json", toolCalls: [] };
    },
  };

  const plan = await proposePlan(
    { planner: failingPlanner },
    { description: "test" }
  );

  expect(plan).toBeNull();
  expect(callCount).toBe(2);
});

test("proposePlan includes mockup refs in user message", async () => {
  let capturedMessage = "";
  const capturingPlanner: IProvider = {
    complete: async (msgs) => {
      const userMsg = msgs.find((m) => m.role === "user");

      if (userMsg) {
        capturedMessage = userMsg.content;
      }

      return {
        content: JSON.stringify(mockPlan),
        toolCalls: [],
      };
    },
  };

  await proposePlan(
    { planner: capturingPlanner },
    {
      description: "test app",
      mockups: ["/path/to/mockup1.png", "/path/to/mockup2.png"],
    }
  );
  expect(capturedMessage).toContain("test app");
  expect(capturedMessage).toContain("/path/to/mockup1.png");
  expect(capturedMessage).toContain("/path/to/mockup2.png");
});

test("parsePlanJson extracts JSON from fenced code blocks", () => {
  const fenced = `\`\`\`json
${JSON.stringify(mockPlan)}
\`\`\``;
  const result = parsePlanJson(fenced);

  expect(result?.slices[0]?.entity.id).toBe("Bookmark");
});

test("parsePlanJson rejects invalid plan shape", () => {
  const invalid = JSON.stringify({ product: "test" }); // missing slices
  const result = parsePlanJson(invalid);

  expect(result).toBeNull();
});
