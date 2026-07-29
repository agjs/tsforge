import { test, expect } from "bun:test";
import {
  serializePlan,
  parsePlan,
  writePlan,
  readPlan,
  loadApprovedPlan,
} from "../src/loop/planning/plan-store";
import type { IProductPlan } from "../src/loop/planning/plan-types";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const PLAN: IProductPlan = {
  product: "A team bookmarking app.",
  slices: [
    {
      entity: {
        id: "Bookmark",
        desc: "a saved link",
        fields: [
          { name: "url", type: "string" },
          { name: "description", type: "string", optional: true },
        ],
        relationships: ["belongsTo User"],
        rules: ["url required"],
      },
      ui: {
        screens: ["list", "form"],
        action: "save a bookmark → it appears in the list",
        shows: ["url", "description"],
        nav: "Bookmarks",
      },
      verification: {
        mustRemainTrue: ["listing requires auth"],
        mustNotHappen: ["saving without a url"],
        acceptanceCheck: "bun test tests/api/bookmark",
      },
    },
  ],
};

test("plan round-trips through serialize/parse with status", () => {
  const text = serializePlan(PLAN, "approved");
  const parsed = parsePlan(text);

  expect(parsed?.status).toBe("approved");
  expect(parsed?.plan.slices[0]?.entity.fields.map((f) => f.name)).toEqual([
    "url",
    "description",
  ]);
});

// Spec 1B — the layout capability: a slice may declare a layout archetype + a home landing.
test("plan round-trips a slice's layout archetype + home marker", () => {
  const plan: IProductPlan = {
    product: "Todos",
    slices: [
      {
        entity: {
          id: "Task",
          desc: "a task",
          fields: [{ name: "title", type: "string" }],
          relationships: ["belongsTo User"],
          rules: ["title required"],
        },
        ui: {
          screens: ["list", "form"],
          action: "add → list",
          shows: ["title"],
          nav: "Tasks",
          layout: "app-sidebar",
          home: true,
        },
        verification: {
          mustRemainTrue: ["auth"],
          mustNotHappen: ["no title"],
          acceptanceCheck: "bun test",
        },
      },
    ],
  };
  const parsed = parsePlan(serializePlan(plan, "approved"));

  expect(parsed?.plan.slices[0]?.ui.layout).toBe("app-sidebar");
  expect(parsed?.plan.slices[0]?.ui.home).toBe(true);
});

// A malformed slice is built as raw text (the type would forbid an invalid layout / can't easily
// express "two homes are wrong"), mirroring the other reject-by-default tests below.
const sliceJson = (id: string, extraUi: Record<string, unknown>): unknown => ({
  entity: {
    id,
    desc: "d",
    fields: [{ name: "title", type: "string" }],
    relationships: ["belongsTo User"],
    rules: ["title required"],
  },
  ui: {
    screens: ["list"],
    action: "a",
    shows: ["title"],
    nav: id,
    ...extraUi,
  },
  verification: {
    mustRemainTrue: ["auth"],
    mustNotHappen: ["bad"],
    acceptanceCheck: "bun test",
  },
});

const planText = (slices: unknown[]): string =>
  `---\nstatus: approved\n---\n\`\`\`json\n${JSON.stringify({ product: "x", slices })}\n\`\`\``;

test("parsePlan rejects an unknown layout archetype", () => {
  expect(
    parsePlan(planText([sliceJson("Task", { layout: "carousel" })]))
  ).toBeNull();
});

test("parsePlan rejects a roadmap-only archetype not yet implemented (public/app-topnav/focused)", () => {
  // These are in the LayoutArchetype vocabulary but NOT implemented; accepting them would silently
  // mis-build — critically `public` implies unauthenticated but routing wraps everything in
  // ProtectedRoute, so it'd be authenticated. Validation gates on IMPLEMENTED_LAYOUT_ARCHETYPES.
  for (const layout of ["public", "app-topnav", "focused"]) {
    expect(parsePlan(planText([sliceJson("Task", { layout })]))).toBeNull();
  }
});

test("parsePlan rejects more than one home slice", () => {
  expect(
    parsePlan(
      planText([sliceJson("A", { home: true }), sliceJson("B", { home: true })])
    )
  ).toBeNull();
});

test("parsePlan accepts exactly one home slice", () => {
  const parsed = parsePlan(
    planText([sliceJson("A", { home: true }), sliceJson("B", {})])
  );

  expect(parsed).not.toBeNull();
});

test("parsePlan rejects a non-boolean home value", () => {
  expect(parsePlan(planText([sliceJson("A", { home: "true" })]))).toBeNull();
  expect(parsePlan(planText([sliceJson("A", { home: 1 })]))).toBeNull();
});

test("parsePlan accepts zero home slices (login falls back to the scaffold default)", () => {
  expect(
    parsePlan(planText([sliceJson("A", {}), sliceJson("B", {})]))
  ).not.toBeNull();
});

test("parsePlan accepts a slice omitting both layout and home (backward compatible)", () => {
  const parsed = parsePlan(planText([sliceJson("A", {})]));

  expect(parsed).not.toBeNull();
  expect(parsed?.plan.slices[0]?.ui.layout).toBeUndefined();
  expect(parsed?.plan.slices[0]?.ui.home).toBeUndefined();
});

test("a malformed artifact parses to null (reject-by-default)", () => {
  expect(parsePlan("not a plan")).toBeNull();
});

test("writePlan and readPlan round-trip to disk", async () => {
  const tmpDir = await mkdtemp("/tmp/tsforge-test-");

  await writePlan(tmpDir, PLAN, "draft");
  const result = await readPlan(tmpDir);

  expect(result?.status).toBe("draft");
  expect(result?.plan.product).toBe("A team bookmarking app.");
  expect(result?.plan.slices).toHaveLength(1);
});

test("readPlan returns null when no plan exists", async () => {
  const tmpDir = await mkdtemp("/tmp/tsforge-test-");
  const result = await readPlan(tmpDir);

  expect(result).toBeNull();
});

test("parsePlan rejects missing product field", () => {
  const malformed = `---
status: draft
---
\`\`\`json
{"slices": []}
\`\`\``;

  expect(parsePlan(malformed)).toBeNull();
});

test("parsePlan rejects missing slices field", () => {
  const malformed = `---
status: draft
---
\`\`\`json
{"product": "test"}
\`\`\``;

  expect(parsePlan(malformed)).toBeNull();
});

test("parsePlan rejects missing frontmatter", () => {
  const malformed = `\`\`\`json
{"product": "test", "slices": []}
\`\`\``;

  expect(parsePlan(malformed)).toBeNull();
});

test("parsePlan rejects malformed JSON block", () => {
  const malformed = `---
status: draft
---
\`\`\`json
{invalid json}
\`\`\``;

  expect(parsePlan(malformed)).toBeNull();
});

test("parsePlan rejects invalid status value", () => {
  const malformed = `---
status: invalid
---
\`\`\`json
{"product": "test", "slices": []}
\`\`\``;

  expect(parsePlan(malformed)).toBeNull();
});

test("parsePlan rejects slice missing entity", () => {
  const malformed = `---
status: draft
---
\`\`\`json
{
  "product": "test",
  "slices": [
    {
      "ui": {},
      "verification": {}
    }
  ]
}
\`\`\``;

  expect(parsePlan(malformed)).toBeNull();
});

test("parsePlan rejects slice missing verification", () => {
  const malformed = `---
status: draft
---
\`\`\`json
{
  "product": "test",
  "slices": [
    {
      "entity": {
        "id": "Test",
        "desc": "test",
        "fields": [],
        "relationships": [],
        "rules": []
      },
      "ui": {}
    }
  ]
}
\`\`\``;

  expect(parsePlan(malformed)).toBeNull();
});

test("parsePlan rejects verification with empty mustNotHappen array", () => {
  const malformed = `---
status: draft
---
\`\`\`json
{
  "product": "test",
  "slices": [
    {
      "entity": {
        "id": "Bookmark",
        "desc": "a saved link",
        "fields": [
          { "name": "url", "type": "string" }
        ],
        "relationships": [],
        "rules": []
      },
      "ui": {
        "screens": ["list"],
        "action": "test",
        "shows": ["url"],
        "nav": "Test"
      },
      "verification": {
        "mustRemainTrue": [],
        "mustNotHappen": [],
        "acceptanceCheck": "test"
      }
    }
  ]
}
\`\`\``;

  expect(parsePlan(malformed)).toBeNull();
});

test("parsePlan rejects ui.screens with invalid string value", () => {
  const malformed = `---
status: draft
---
\`\`\`json
{
  "product": "test",
  "slices": [
    {
      "entity": {
        "id": "Bookmark",
        "desc": "a saved link",
        "fields": [
          { "name": "url", "type": "string" }
        ],
        "relationships": [],
        "rules": []
      },
      "ui": {
        "screens": ["list", "invalid"],
        "action": "test",
        "shows": ["url"],
        "nav": "Test"
      },
      "verification": {
        "mustRemainTrue": [],
        "mustNotHappen": ["test"],
        "acceptanceCheck": "test"
      }
    }
  ]
}
\`\`\``;

  expect(parsePlan(malformed)).toBeNull();
});

test("parsePlan rejects ui.screens with non-string value", () => {
  const malformed = `---
status: draft
---
\`\`\`json
{
  "product": "test",
  "slices": [
    {
      "entity": {
        "id": "Bookmark",
        "desc": "a saved link",
        "fields": [
          { "name": "url", "type": "string" }
        ],
        "relationships": [],
        "rules": []
      },
      "ui": {
        "screens": ["list", 5],
        "action": "test",
        "shows": ["url"],
        "nav": "Test"
      },
      "verification": {
        "mustRemainTrue": [],
        "mustNotHappen": ["test"],
        "acceptanceCheck": "test"
      }
    }
  ]
}
\`\`\``;

  expect(parsePlan(malformed)).toBeNull();
});

test("parsePlan rejects entity with empty id", () => {
  const malformed = `---
status: draft
---
\`\`\`json
{
  "product": "test",
  "slices": [
    {
      "entity": {
        "id": "",
        "desc": "a saved link",
        "fields": [
          { "name": "url", "type": "string" }
        ],
        "relationships": [],
        "rules": []
      },
      "ui": {
        "screens": ["list"],
        "action": "test",
        "shows": ["url"],
        "nav": "Test"
      },
      "verification": {
        "mustRemainTrue": [],
        "mustNotHappen": ["test"],
        "acceptanceCheck": "test"
      }
    }
  ]
}
\`\`\``;

  expect(parsePlan(malformed)).toBeNull();
});

test("parsePlan rejects field with empty name", () => {
  const malformed = `---
status: draft
---
\`\`\`json
{
  "product": "test",
  "slices": [
    {
      "entity": {
        "id": "Bookmark",
        "desc": "a saved link",
        "fields": [
          { "name": "", "type": "string" }
        ],
        "relationships": [],
        "rules": []
      },
      "ui": {
        "screens": ["list"],
        "action": "test",
        "shows": ["url"],
        "nav": "Test"
      },
      "verification": {
        "mustRemainTrue": [],
        "mustNotHappen": ["test"],
        "acceptanceCheck": "test"
      }
    }
  ]
}
\`\`\``;

  expect(parsePlan(malformed)).toBeNull();
});

test("loadApprovedPlan returns null for a draft, the plan when approved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-"));

  try {
    await writePlan(dir, PLAN, "draft");
    expect(await loadApprovedPlan(dir)).toBeNull();
    await writePlan(dir, PLAN, "approved");
    expect((await loadApprovedPlan(dir))?.slices.length).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
