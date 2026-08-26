import { readFile } from "node:fs/promises";
import type { IPlanConstraints } from "../planning/plan-types";
import type { IStackAdapter } from "../planning/stack-adapter";
import { readScaffoldArchetype } from "../../scaffold/receipt";
import { phaserConventionProvider } from "./conventions";
import { phaserContextBrief } from "./context-brief";
import { phaserPlanSchemaErased } from "./plan-extension";

export const PHASER_PLANNER_GUIDANCE = `This build targets the Phaser-TypeScript-AI-First-Starter. It SHIPS a WASD grid demo (Player, Grid, Wall, Movement, Interaction, Hud, SaveGame, Progression, Boot/World). That demo is a placeholder, not the product.

Plan PLAYABLE SYSTEMS of the game the user asked for (Flap, Pipes, Crash, Score) — not a CRUD list of sprites (Bird, Pipe, Score as records) and not coins-on-a-grid unless they asked for a grid collectathon.

Do NOT emit slices named Player, Grid, Wall, Movement, Hud, Save, Boot, or World. Do NOT keep WASD as the core loop of a different genre. Add new features on World (or a new scene) that ARE the new loop. Domain stays Phaser-free; features tick+dispose; scenes are thin views with SHUTDOWN dispose.`;

export const PHASER_RESERVED_ENTITY_IDS: ReadonlySet<string> = new Set([
  "player",
  "grid",
  "wall",
  "movement",
  "interaction",
  "hud",
  "savegame",
  "save",
  "progression",
  "boot",
  "world",
]);

export async function isPhaserProject(
  dir: string,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf-8")
): Promise<boolean> {
  return (await readScaffoldArchetype(dir, read)) === "phaser";
}

export function phaserPlanConstraints(
  onStripped: (droppedEntityIds: readonly string[]) => void
): IPlanConstraints {
  return {
    guidance: PHASER_PLANNER_GUIDANCE,
    reservedEntities: PHASER_RESERVED_ENTITY_IDS,
    onStripped,
  };
}

export const phaserStackAdapter: IStackAdapter = {
  id: "phaser",
  detect: (dir) => isPhaserProject(dir),
  planConstraints: phaserPlanConstraints,
  planSchema: phaserPlanSchemaErased,
  conventions: phaserConventionProvider,
  contextBrief: (dir) => phaserContextBrief(dir),
};
