import { test, expect } from "bun:test";
import {
  proposePlan,
  parsePlanJson,
  stripReservedSlices,
  PLANNER_EXAMPLE,
} from "../src/loop/planning/propose-plan";
import type { IProductPlan } from "../src/loop/planning/plan-types";
import { isProductPlan } from "../src/loop/planning/plan-store";
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

function userSlice(id: string) {
  return {
    entity: {
      id,
      desc: "an account",
      fields: [{ name: "email", type: "string" }],
      relationships: [],
      rules: [],
    },
    ui: {
      screens: ["form"],
      action: "sign up / log in",
      shows: ["email"],
      nav: id,
    },
    verification: {
      mustRemainTrue: ["auth"],
      mustNotHappen: ["no email"],
      acceptanceCheck: "bun test",
    },
  };
}

test("stripReservedSlices drops an identity slice the stack ships but keeps real ones", () => {
  const plan = {
    ...mockPlan,
    slices: [userSlice("User"), mockPlan.slices[0]],
  } as IProductPlan;

  const stripped = stripReservedSlices(plan);

  expect(stripped.slices.map((s) => s.entity.id)).toEqual(["Bookmark"]);
});

test("stripReservedSlices keeps the original when EVERY slice is reserved (no empty plan)", () => {
  const plan = {
    ...mockPlan,
    slices: [userSlice("User"), userSlice("Session")],
  } as IProductPlan;

  // An all-auth plan is mis-scoped, but an empty plan builds nothing — keep it.
  expect(stripReservedSlices(plan).slices).toHaveLength(2);
});

test("proposePlan strips a redundant User slice (the live bookmark-app collision)", async () => {
  // The exact failure observed live: the planner returned User + Bookmark; the
  // User slice's locale keys never wired up (real auth lives in the scaffold),
  // so the gate looped forever on unused keys. proposePlan must not emit it.
  const planner: IProvider = {
    complete: async () => ({
      content: JSON.stringify({
        ...mockPlan,
        slices: [userSlice("User"), mockPlan.slices[0]],
      }),
      toolCalls: [],
    }),
  };

  const plan = await proposePlan({ planner }, { description: "bookmarks" });

  expect(plan?.slices.map((s) => s.entity.id)).toEqual(["Bookmark"]);
});

test("PLANNER_EXAMPLE proposes no reserved identity entity", () => {
  // The worked example must model good behaviour: no User/Auth/Session slice.
  const ids = PLANNER_EXAMPLE.slices.map((s) => s.entity.id.toLowerCase());

  expect(ids).not.toContain("user");
  expect(ids).not.toContain("auth");
});

test("PLANNER_EXAMPLE (the shape shown to the model) is itself a valid plan", () => {
  // The prompt teaches the model by example. If a future edit breaks the
  // example's shape, the contract we advertise diverges from what the parser
  // accepts — and the live model dutifully copies the broken shape. Guard it:
  // the worked example must round-trip through the same strict guard.
  expect(isProductPlan(PLANNER_EXAMPLE)).toBe(true);
  expect(parsePlanJson(JSON.stringify(PLANNER_EXAMPLE))).not.toBeNull();
});
