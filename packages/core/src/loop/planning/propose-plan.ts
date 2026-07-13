import type { IProvider } from "../../inference";
import { extractJson } from "../../lib/json";
import { isProductPlan } from "./plan-store";
import type { IProductPlan } from "./plan-types";

/**
 * A complete, valid example plan shown to the model to pin the exact output
 * shape. Typed as IProductPlan (via `satisfies`) so the compiler guarantees the
 * example we teach the model is itself a legal plan; a regression test asserts
 * `isProductPlan(PLANNER_EXAMPLE)`. Serialized into PLANNER_SYSTEM below.
 */
export const PLANNER_EXAMPLE = {
  product:
    "A personal task tracker for a single user to capture and complete to-dos.",
  slices: [
    {
      entity: {
        id: "Task",
        desc: "A single to-do item owned by a user.",
        fields: [
          { name: "title", type: "string" },
          { name: "done", type: "boolean" },
          { name: "dueDate", type: "Date", optional: true },
        ],
        relationships: ["belongs to a User"],
        rules: ["title must not be empty", "a user only sees their own tasks"],
      },
      ui: {
        screens: ["list", "detail", "form"],
        action: "create, complete, and delete tasks",
        shows: ["title", "done", "dueDate"],
        nav: "Tasks",
      },
      verification: {
        mustRemainTrue: ["only the owner can see or change a task"],
        mustNotHappen: ["a user must not see another user's tasks"],
        acceptanceCheck: "bun test",
      },
    },
  ],
} satisfies IProductPlan;

/**
 * System prompt for the product architect role: turn a product description
 * + optional mockups into a structured product plan (domain model + slices + UI
 * + verification). The schema is pinned with EXACT key names and a flat screen
 * enum, plus the worked PLANNER_EXAMPLE, because a loosely-described shape lets
 * a model invent its own keys (primaryAction/navigationLabel/screen objects)
 * that the strict parser then rejects.
 */
const PLANNER_SYSTEM = `You are a product architect. From the product description and any mockups, propose a domain model as feature slices (one per entity). Respond with ONLY a JSON object — no prose, no markdown fences — matching this schema EXACTLY. Use these exact key names and value shapes; do not add, rename, or nest differently.

Schema:
{
  "product": "<one short paragraph: what the product is for>",
  "slices": [
    {
      "entity": {
        "id": "<PascalCase noun, e.g. Bookmark>",
        "desc": "<one line>",
        "fields": [ { "name": "<camelCase>", "type": "<string|number|boolean|Date|string[]>", "optional": <true if omittable, else omit this key> } ],
        "relationships": [ "<plain-English sentence, e.g. 'belongs to a User'>" ],
        "rules": [ "<plain-English invariant, e.g. 'title must not be empty'>" ]
      },
      "ui": {
        "screens": [ <any of "list", "detail", "form", "dashboard" — these EXACT lowercase words only, nothing else> ],
        "action": "<the primary thing a user does, one line>",
        "shows": [ "<field or thing shown on screen>" ],
        "nav": "<navigation label, e.g. Bookmarks>"
      },
      "verification": {
        "mustRemainTrue": [ "<invariant that must always hold>" ],
        "mustNotHappen": [ "<at least one thing that must never happen>" ],
        "acceptanceCheck": "<a shell command that verifies the slice, e.g. bun test>"
      }
    }
  ]
}

Rules for the JSON:
- "screens" is a flat array of the literal words list/detail/form/dashboard ONLY — never objects, never other words.
- "relationships" and "rules" are arrays of plain STRINGS, never objects.
- "fields" uses "optional" (boolean), never "required".
- Use "desc" (not "description"), "action" (not "primaryAction"), "nav" (not "navigationLabel"), "acceptanceCheck" (not "acceptanceCheckCommand").
- "mustNotHappen" must have at least one entry.

Complete example (follow this shape precisely):
${JSON.stringify(PLANNER_EXAMPLE, null, 2)}`;

/**
 * Parse the planner's raw JSON reply into an IProductPlan, or null on failure.
 * Pure — split out so it can be unit-tested without a provider.
 */
export function parsePlanJson(raw: string): IProductPlan | null {
  try {
    const json: unknown = JSON.parse(extractJson(raw));

    return isProductPlan(json) ? json : null;
  } catch {
    return null;
  }
}

/**
 * Ask the model to propose a structured product plan from a description.
 * Returns null when the model's response can't be parsed into a usable plan.
 * Retries once at higher temperature (0 → 0.7) on parse failure.
 */
export async function proposePlan(
  deps: { planner: IProvider },
  input: { description: string; mockups?: readonly string[] }
): Promise<IProductPlan | null> {
  const userMessage =
    input.mockups !== undefined && input.mockups.length > 0
      ? `Product description: ${input.description}\n\nMockup refs: ${input.mockups.join(", ")}`
      : `Product description: ${input.description}`;

  // First attempt: temperature 0 (deterministic)
  const res1 = await deps.planner.complete(
    [
      { role: "system", content: PLANNER_SYSTEM },
      { role: "user", content: userMessage },
    ],
    { temperature: 0 }
  );

  const parsed1 = parsePlanJson(res1.content);

  if (parsed1 !== null) {
    return parsed1;
  }

  // Retry: temperature 0.7 (more creative/forgiving)
  const res2 = await deps.planner.complete(
    [
      { role: "system", content: PLANNER_SYSTEM },
      { role: "user", content: userMessage },
    ],
    { temperature: 0.7 }
  );

  return parsePlanJson(res2.content);
}
