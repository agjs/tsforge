import { test, expect } from "bun:test";
import {
  proposePlan,
  parsePlanJson,
  stripReservedSlices,
  PLANNER_EXAMPLE,
} from "../src/loop/planning/propose-plan";
import {
  BORINGSTACK_PLANNER_GUIDANCE,
  BORINGSTACK_RESERVED_ENTITY_IDS,
} from "../src/loop/planning/boringstack-planning";
import type { IProductPlan, ISlice } from "../src/loop/planning/plan-types";
import { isProductPlan } from "../src/loop/planning/plan-store";
import type { IProvider } from "../src/inference";

const bookmarkSlice = {
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
} satisfies ISlice;

const mockPlan = {
  product: "A bookmarking app.",
  slices: [bookmarkSlice],
} satisfies IProductPlan;

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

function authSlice(id: string): ISlice {
  return {
    entity: {
      id,
      desc: "an identity concept",
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

/** Build a planner that returns exactly the given slices. */
function plannerOf(slices: ISlice[]): IProvider {
  return {
    complete: async () => ({
      content: JSON.stringify({ product: "p", slices }),
      toolCalls: [],
    }),
  };
}

// The BoringStack opt-in a stack-aware caller passes; the generic planner passes
// nothing (see the stack-agnostic test below). onStripped is REQUIRED by the type
// whenever reservedEntities is set — a drop can never be silent.
const BS = {
  guidance: BORINGSTACK_PLANNER_GUIDANCE,
  reservedEntities: BORINGSTACK_RESERVED_ENTITY_IDS,
  onStripped: () => undefined,
};

test("stripReservedSlices drops a reserved slice but keeps real ones", () => {
  const stripped = stripReservedSlices(
    { product: "p", slices: [authSlice("User"), bookmarkSlice] },
    BORINGSTACK_RESERVED_ENTITY_IDS
  );

  expect(stripped.slices.map((s) => s.entity.id)).toEqual(["Bookmark"]);
});

test("stripReservedSlices drops case + plural variants (User, users, SignUp, LogIn)", () => {
  for (const id of ["User", "users", "SignUp", "LogIn", "AUTH"]) {
    const stripped = stripReservedSlices(
      { product: "p", slices: [authSlice(id), bookmarkSlice] },
      BORINGSTACK_RESERVED_ENTITY_IDS
    );

    expect(stripped.slices.map((s) => s.entity.id)).toEqual(["Bookmark"]);
  }
});

test("the BoringStack reserved set KEEPS ambiguous domain entities (Account/Session/Profile/Credential)", () => {
  // These are real product domains elsewhere (billing, therapy, social,
  // certification) — reserving them would silently delete required features.
  for (const id of ["Account", "Session", "Profile", "Credential"]) {
    const stripped = stripReservedSlices(
      { product: "p", slices: [authSlice(id)] },
      BORINGSTACK_RESERVED_ENTITY_IDS
    );

    expect(stripped.slices.map((s) => s.entity.id)).toEqual([id]);
  }
});

test("STACK-AGNOSTIC: with NO constraints, proposePlan does NOT strip a User slice", async () => {
  // The generic planner must never assume a stack ships auth. A plain build that
  // legitimately needs a User entity keeps it — the bug that leaked BoringStack
  // assumptions into the core planner.
  const plan = await proposePlan(
    { planner: plannerOf([authSlice("User"), bookmarkSlice]) },
    { description: "an app with real users" }
  );

  expect(plan?.slices.map((s) => s.entity.id)).toEqual(["User", "Bookmark"]);
});

test("STACK-AGNOSTIC: the base system prompt says nothing about auth being provided", async () => {
  let system = "";
  const planner: IProvider = {
    complete: async (msgs) => {
      system = msgs.find((m) => m.role === "system")?.content ?? "";

      return { content: JSON.stringify(mockPlan), toolCalls: [] };
    },
  };

  await proposePlan({ planner }, { description: "x" }); // no constraints

  expect(system).not.toContain("ALREADY PROVIDES authentication");
  expect(system).not.toContain("auth surface");
});

test("stripping is SURFACED via onStripped, not silent", async () => {
  const dropped: string[][] = [];

  await proposePlan(
    { planner: plannerOf([authSlice("User"), bookmarkSlice]) },
    { description: "bookmarks" },
    { ...BS, onStripped: (ids) => dropped.push([...ids]) }
  );

  expect(dropped).toEqual([["User"]]);
});

test("BoringStack opt-in strips a redundant User slice (the live bookmark-app collision)", async () => {
  const plan = await proposePlan(
    { planner: plannerOf([authSlice("User"), bookmarkSlice]) },
    { description: "bookmarks" },
    BS
  );

  expect(plan?.slices.map((s) => s.entity.id)).toEqual(["Bookmark"]);
});

test("BoringStack opt-in appends its auth guidance to the system prompt", async () => {
  let system = "";
  const planner: IProvider = {
    complete: async (msgs) => {
      system = msgs.find((m) => m.role === "system")?.content ?? "";

      return { content: JSON.stringify(mockPlan), toolCalls: [] };
    },
  };

  await proposePlan({ planner }, { description: "x" }, BS);

  expect(system).toContain("BoringStack");
  expect(system).toContain("ALREADY PROVIDES authentication");
});

test("BoringStack opt-in: an all-auth plan on BOTH attempts strips to NULL (finite failure)", async () => {
  let calls = 0;
  const planner: IProvider = {
    complete: async () => {
      calls += 1;

      return {
        content: JSON.stringify({
          product: "p",
          slices: [authSlice("User"), authSlice("Login")],
        }),
        toolCalls: [],
      };
    },
  };

  const plan = await proposePlan({ planner }, { description: "just auth" }, BS);

  expect(plan).toBeNull();
  // An all-auth first attempt is retried once (a fresh try may yield real slices).
  expect(calls).toBe(2);
});

test("BoringStack opt-in: an all-auth first attempt RETRIES and recovers a real second plan", async () => {
  let calls = 0;
  const planner: IProvider = {
    complete: async () => {
      calls += 1;

      return calls === 1
        ? {
            content: JSON.stringify({
              product: "p",
              slices: [authSlice("User")],
            }),
            toolCalls: [],
          }
        : {
            content: JSON.stringify({ product: "p", slices: [bookmarkSlice] }),
            toolCalls: [],
          };
    },
  };

  const plan = await proposePlan({ planner }, { description: "bookmarks" }, BS);

  expect(calls).toBe(2);
  expect(plan?.slices.map((s) => s.entity.id)).toEqual(["Bookmark"]);
});

test("BoringStack opt-in: stripping also applies on the temperature-0.7 retry path", async () => {
  let call = 0;
  const planner: IProvider = {
    complete: async () => {
      call += 1;

      // First attempt: unparseable → forces the retry. Retry: User + Bookmark.
      return call === 1
        ? { content: "not json", toolCalls: [] }
        : {
            content: JSON.stringify({
              product: "p",
              slices: [authSlice("User"), bookmarkSlice],
            }),
            toolCalls: [],
          };
    },
  };

  const plan = await proposePlan({ planner }, { description: "bookmarks" }, BS);

  expect(call).toBe(2);
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
