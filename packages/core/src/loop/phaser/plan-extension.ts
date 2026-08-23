import { isRecord } from "../../lib/guards";
import type { IProductPlan, IPlanSchema } from "../planning/plan-types";

/**
 * Phaser's PLAN EXTENSION — view intent for a game slice (scene / feature /
 * domain module / content catalog), kept OUT of the core plan spine. Core never
 * names screens/nav/layout; this adapter supplies the concrete `ui` shape.
 */

export const PHASER_VIEW_KINDS = [
  "feature",
  "scene",
  "module",
  "content",
  "port",
] as const;

export type PhaserViewKind = (typeof PHASER_VIEW_KINDS)[number];

export const PHASER_CATALOGS = [
  "items",
  "levels",
  "tileTypes",
  "balance",
] as const;

export type PhaserCatalog = (typeof PHASER_CATALOGS)[number];

export const PHASER_INPUTS = ["keyboard", "pointer", "none"] as const;

export type PhaserInput = (typeof PHASER_INPUTS)[number];

export interface IPhaserViewIntent {
  readonly kind: PhaserViewKind;
  /** Scene key id (World, Boot, or a new branded key). */
  readonly scene: string;
  /** src/features/<name> when kind is feature. */
  readonly feature?: string;
  /** Content catalog when kind is content (optional extra on a feature). */
  readonly catalog?: PhaserCatalog;
  readonly input?: PhaserInput;
}

export type PhaserProductPlan = IProductPlan<IPhaserViewIntent>;

const KIND_SET = new Set<string>(PHASER_VIEW_KINDS);
const CATALOG_SET = new Set<string>(PHASER_CATALOGS);
const INPUT_SET = new Set<string>(PHASER_INPUTS);
const SCENE_ID = /^[A-Za-z][A-Za-z0-9]*$/u;
const FEATURE_ID = /^[A-Za-z][A-Za-z0-9-]*$/u;

function isKind(value: string): value is PhaserViewKind {
  return KIND_SET.has(value);
}

function isCatalog(value: string): value is PhaserCatalog {
  return CATALOG_SET.has(value);
}

function isInput(value: string): value is PhaserInput {
  return INPUT_SET.has(value);
}

export function isPhaserViewIntent(value: unknown): value is IPhaserViewIntent {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.kind !== "string" || !isKind(value.kind)) {
    return false;
  }

  if (typeof value.scene !== "string" || !SCENE_ID.test(value.scene)) {
    return false;
  }

  if (
    value.kind === "feature" &&
    (typeof value.feature !== "string" || !FEATURE_ID.test(value.feature))
  ) {
    return false;
  }

  if (value.kind === "port" && value.feature !== undefined) {
    return false;
  }

  if (
    value.kind === "content" &&
    (typeof value.catalog !== "string" || !isCatalog(value.catalog))
  ) {
    return false;
  }

  if (
    value.kind !== "content" &&
    value.catalog !== undefined &&
    (typeof value.catalog !== "string" || !isCatalog(value.catalog))
  ) {
    return false;
  }

  if (
    value.input !== undefined &&
    (typeof value.input !== "string" || !isInput(value.input))
  ) {
    return false;
  }

  return true;
}

export const PLANNER_EXAMPLE = {
  product:
    "A grid adventure that adds collectible coins on the existing World scene.",
  slices: [
    {
      entity: {
        id: "Coin",
        desc: "A collectible coin the player picks up for score.",
        fields: [
          { name: "value", type: "number" },
          { name: "collected", type: "boolean" },
        ],
        relationships: ["exists on the World grid"],
        rules: ["a coin is collected at most once"],
      },
      ui: {
        kind: "feature",
        scene: "World",
        feature: "coin",
        catalog: "items",
        input: "none",
      },
      verification: {
        mustRemainTrue: ["collecting a coin increases score by its value"],
        mustNotHappen: ["a collected coin cannot be collected again"],
        acceptanceCheck: "bun test",
      },
    },
  ],
} satisfies IProductPlan<IPhaserViewIntent>;

export const PLANNER_SYSTEM = `You are a product architect for a Phaser 4 TypeScript game built from the Phaser-TypeScript-AI-First-Starter. From the product description, propose a domain model as feature slices (one per entity). Respond with ONLY a JSON object — no prose, no markdown fences — matching this schema EXACTLY. Use these exact key names and value shapes; do not add, rename, or nest differently.

Schema:
{
  "product": "<one short paragraph: what the game is for>",
  "slices": [
    {
      "entity": {
        "id": "<PascalCase noun, e.g. Coin>",
        "desc": "<one line>",
        "fields": [ { "name": "<camelCase>", "type": "<string|number|boolean|Date|string[]>", "optional": <true if omittable, else omit this key> } ],
        "relationships": [ "<plain-English sentence>" ],
        "rules": [ "<plain-English invariant>" ]
      },
      "ui": {
        "kind": "<feature | scene | module | content | port>",
        "scene": "<existing or new scene key id, e.g. World — never a raw scene.start string literal>",
        "feature": "<OPTIONAL: src/features folder name when kind is feature, e.g. coin>",
        "catalog": "<OPTIONAL: items | levels | tileTypes | balance>",
        "input": "<OPTIONAL: keyboard | pointer | none>"
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
- This is NOT a web app. Do not emit screens, nav, layout, or home. The slice "ui" is a Phaser view intent.
- "kind": "feature" requires "feature". "kind": "content" requires "catalog". "kind": "port" omits "feature".
- "scene" is an identifier (World, Boot, Shop), never a path.
- Domain lives in src/domain and MUST NOT import phaser. Features tick + dispose. Scenes are thin Phaser.Scene + setup returning { update, dispose } with events.once(SHUTDOWN).
- Prefer bun run new:feature / new:scene / new:module, then fill in. import * as Phaser from 'phaser'. Branded scene/texture keys.
- Do NOT rebuild Player, Grid, Wall, Movement, Interaction, Hud, SaveGame, or the Boot/World scenes — the starter already ships those. Extend them.

Complete example (follow this shape precisely):
${JSON.stringify(PLANNER_EXAMPLE, null, 2)}`;

function phaserExtraCheck(plan: IProductPlan): boolean {
  for (const slice of plan.slices) {
    if (!isPhaserViewIntent(slice.ui)) {
      return false;
    }

    if (slice.ui.kind === "port" && slice.ui.feature !== undefined) {
      return false;
    }
  }

  return true;
}

export const phaserPlanSchema: IPlanSchema<IPhaserViewIntent> = {
  system: PLANNER_SYSTEM,
  validateUi: isPhaserViewIntent,
  extraCheck: phaserExtraCheck,
};

export const phaserPlanSchemaErased: IPlanSchema<unknown> = {
  system: PLANNER_SYSTEM,
  validateUi: isPhaserViewIntent,
  extraCheck: phaserExtraCheck,
};
