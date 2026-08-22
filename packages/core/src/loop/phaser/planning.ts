import { readFile } from "node:fs/promises";
import type { IPlanConstraints } from "../planning/plan-types";
import type { IStackAdapter } from "../planning/stack-adapter";
import { readScaffoldArchetype } from "../../scaffold/receipt";
import { phaserConventionProvider } from "./conventions";
import { phaserPlanSchemaErased } from "./plan-extension";

export const PHASER_PLANNER_GUIDANCE = `This build targets the Phaser-TypeScript-AI-First-Starter, which ALREADY PROVIDES a WASD grid demo: Player, Grid, Wall, Movement, Interaction, Hud, SaveGame, Progression, and Boot/World scenes. Do NOT propose a slice that REBUILDS those — no Player, Grid, Wall, Movement, Hud, Save, Boot, or World entity. Treat them as existing actors/views your new entities extend. Propose the product's own domain (a Coin, a Shop, a new scene) normally. Phaser is a render substrate: domain stays Phaser-free, features tick+dispose, scenes are thin views with SHUTDOWN dispose.`;

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
};
