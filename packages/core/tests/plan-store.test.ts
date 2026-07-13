import { test, expect } from "bun:test";
import {
  serializePlan,
  parsePlan,
  writePlan,
  readPlan,
} from "../src/loop/planning/plan-store";
import type { IProductPlan } from "../src/loop/planning/plan-types";
import { mkdtemp } from "fs/promises";

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
