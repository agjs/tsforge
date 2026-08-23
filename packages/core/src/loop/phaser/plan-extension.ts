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

export const PLANNER_EXAMPLE: IProductPlan<IPhaserViewIntent> = {
  product:
    "A side-scrolling flap game: tap to rise, fall with gravity, dodge scrolling pipe pairs, score for each gap passed.",
  slices: [
    {
      entity: {
        id: "Flap",
        desc: "Gravity pulls the bird down; a tap or key press adds an upward impulse.",
        fields: [
          { name: "vy", type: "number" },
          { name: "alive", type: "boolean" },
        ],
        relationships: ["drives the bird sprite on World"],
        rules: ["a flap while dead does nothing"],
      },
      ui: {
        kind: "feature",
        scene: "World",
        feature: "flap",
        input: "pointer",
      },
      verification: {
        mustRemainTrue: ["without input the bird's vy increases downward"],
        mustNotHappen: ["the bird flies with no gravity"],
        acceptanceCheck: "bun test",
      },
    },
    {
      entity: {
        id: "Pipes",
        desc: "Pipe pairs spawn on the right, scroll left, and recycle off-screen.",
        fields: [
          { name: "speed", type: "number" },
          { name: "gap", type: "number" },
        ],
        relationships: ["obstacles the bird must fly through"],
        rules: ["a pair always has a passable gap"],
      },
      ui: {
        kind: "feature",
        scene: "World",
        feature: "pipes",
        input: "none",
      },
      verification: {
        mustRemainTrue: ["pipes move left every tick while the run is live"],
        mustNotHappen: ["a pipe pair with no gap"],
        acceptanceCheck: "bun test",
      },
    },
    {
      entity: {
        id: "Crash",
        desc: "Overlapping a pipe or leaving the playfield ends the run.",
        fields: [{ name: "hit", type: "boolean" }],
        relationships: ["reads Flap alive and Pipes bounds"],
        rules: ["a crash sets alive false and stops scrolling"],
      },
      ui: {
        kind: "feature",
        scene: "World",
        feature: "crash",
        input: "none",
      },
      verification: {
        mustRemainTrue: ["a crash stops pipe scrolling"],
        mustNotHappen: ["the bird continues after a hit"],
        acceptanceCheck: "bun test",
      },
    },
    {
      entity: {
        id: "Score",
        desc: "Passing a pipe gap adds one point and updates the HUD.",
        fields: [{ name: "value", type: "number" }],
        relationships: ["increments when a pipe pair is cleared"],
        rules: ["score never decreases during a live run"],
      },
      ui: {
        kind: "feature",
        scene: "World",
        feature: "score",
        input: "none",
      },
      verification: {
        mustRemainTrue: ["clearing a gap increases score by 1"],
        mustNotHappen: ["score ticks while the bird is dead"],
        acceptanceCheck: "bun test",
      },
    },
  ],
};

export const PLANNER_SYSTEM = `You are a game designer for a Phaser 4 TypeScript game from the Phaser-TypeScript-AI-First-Starter. From the product description, propose the PLAYABLE SYSTEMS of that game — not a CRUD inventory of sprites. Respond with ONLY a JSON object — no prose, no markdown fences — matching this schema EXACTLY. Use these exact key names and value shapes; do not add, rename, or nest differently.

Schema:
{
  "product": "<one short paragraph: the loop the player feels>",
  "slices": [
    {
      "entity": {
        "id": "<PascalCase SYSTEM name, e.g. Flap or Pipes — never a sprite-noun inventory like Bird>",
        "desc": "<what the player does or what happens, one line>",
        "fields": [ { "name": "<camelCase runtime state>", "type": "<string|number|boolean|Date|string[]>", "optional": <true if omittable, else omit this key> } ],
        "relationships": [ "<which other systems this reads or drives>" ],
        "rules": [ "<a play-feel invariant>" ]
      },
      "ui": {
        "kind": "<feature | scene | module | content | port>",
        "scene": "<World, Boot, or a new scene key — never a scene.start string>",
        "feature": "<REQUIRED when kind is feature: src/features folder, e.g. flap>",
        "catalog": "<OPTIONAL: items | levels | tileTypes | balance>",
        "input": "<keyboard | pointer | none — pointer/keyboard if the player acts>"
      },
      "verification": {
        "mustRemainTrue": [ "<something the player can see in 10 seconds>" ],
        "mustNotHappen": [ "<a fail-state that must never occur>" ],
        "acceptanceCheck": "<bun test>"
      }
    }
  ]
}

Rules for the JSON:
- This is a GAME. Slices are systems the player feels (Flap, Pipes, Crash, Score), NOT database entities and NOT one slice per sprite noun (do not emit Bird + Pipe + Score as "records").
- Plan the game they asked for. If they asked for a flap/arcade/shooter, do NOT turn it into coins on a grid.
- The starter's WASD grid demo (Player, Grid, Wall, Movement) is a placeholder. Do not rebuild those as slices. Do not keep WASD as the core loop of a different genre. Add new features on World (or a new scene) that ARE the new loop.
- This is NOT a web app. No screens, nav, layout, or home.
- "kind": "feature" requires "feature". "kind": "content" requires "catalog". "kind": "port" omits "feature".
- "scene" is an identifier (World, Boot, GameOver), never a path.
- Domain stays Phaser-free. Features tick + dispose. Scenes are thin Phaser.Scene + setup returning { update, dispose } with events.once(SHUTDOWN).
- Prefer bun run new:feature / new:scene / new:module, then fill in.

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
