/**
 * Instant Phaser session context. The adapter already knows this template's
 * layout — the model must not spend turns listing/reading the tree to orient.
 * Static architecture is authored here; the only dest I/O is catalog.md or four
 * directory-name listings.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Cap on the live catalog body so a grown game cannot blow the system prompt. */
export const PHASER_CATALOG_CAP = 6000;

const CATALOG_REL = "docs/ai/catalog.md";

const INDEX_DIRS: readonly string[] = [
  "src/domain",
  "src/features",
  "src/runtime/phaser/scenes",
  "src/content/schemas",
];

/** Injectable I/O so tests can prove we never walk `src/**`. */
export interface IPhaserBriefIo {
  readText(path: string): Promise<string>;
  listNames(dir: string): Promise<readonly string[]>;
}

export const defaultPhaserBriefIo: IPhaserBriefIo = {
  readText: (path) => readFile(path, "utf8"),
  listNames: async (dir) => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const names: string[] = [];

      for (const entry of entries) {
        names.push(entry.name);
      }

      names.sort();

      return names;
    } catch {
      return [];
    }
  },
};

/**
 * Architecture, generators, wire points, reserved demo, and the do-not-walk
 * rule. Catalog / dir names are appended live. Never throws; never empty.
 */
export const PHASER_STATIC_BRIEF = [
  "PHASER HARNESS. This workspace is a Phaser-TypeScript-AI-First-Starter clone (Phaser 4, hybrid composition: thin Scene + setupX → { update, dispose }). Not ECS. Not ManagedScene.",
  "",
  "DO NOT ORIENT BY WALKING THE TREE. Do not ls, find, tree, or rg over src/. Do not read AGENTS.md, BUILD_THE_GAME.md, or docs/ai/* to understand the project. The map below is complete. Read a source file only when you are about to edit it or the user named it. If a name is missing from the live index, it does not exist — generate it with bun run new:*; do not hunt.",
  "",
  "LAYERS (import arrows only downward):",
  "- app → any",
  "- features → features, domain, content, shared — never runtime, never phaser",
  "- runtime → runtime, domain, features, content, shared — never app",
  "- domain → domain, shared",
  "- content → content, shared",
  "- shared → shared only",
  "",
  "HOMES + GENERATORS + WIRE:",
  "- domain module → src/domain/<camel>/ (8-file: types, model, behavior, constants, system, contracts, test, index). bun run new:module -- <Pascal>. No auto-wire; the feature imports it. Domain stays Phaser-free.",
  "- feature → src/features/<camel>/ createXFeature(deps) → { dispose }. bun run new:feature -- <Pascal>. Wire in the target scene *.setup.ts (World → src/runtime/phaser/scenes/WorldScene/WorldScene.setup.ts). Use the existing event bus; do not invent a second one.",
  "- scene → src/runtime/phaser/scenes/<Name>Scene/ thin class + setupX, events.once(SHUTDOWN, dispose), branded NAME_SCENE_KEY. bun run new:scene -- <Name>Scene. Register in src/app/config/gameConfig.ts scene: [BootScene, WorldScene, …]. Boot stays first.",
  "- port → declare in src/shared/types/ports.ts; adapter under src/runtime/adapters/; fake in src/shared/testing. bun run new:port -- <Name>. Construct only in src/app/composition/composeRuntime.ts.",
  "- content → src/content schemas + definitions. bun run new:content -- <Pascal>. Barrels + bun run catalog. No item tables in scenes.",
  "",
  "import * as Phaser from 'phaser'. Never ignoreDestroy. Never construct GameObjects, colliders, or loaders in update. bun run check is the merge bar. Do not start vite, playwright, or bun run dev.",
  "",
  "RESERVED DEMO (do not rebuild): Player, Grid, Wall, Movement, Interaction, Hud, SaveGame, Progression, BootScene, WorldScene. New work extends these.",
].join("\n");

function capCatalog(text: string): string {
  if (text.length <= PHASER_CATALOG_CAP) {
    return text;
  }

  const cut = text.slice(0, PHASER_CATALOG_CAP);
  const lastNl = cut.lastIndexOf("\n");
  const trimmed = lastNl > 0 ? cut.slice(0, lastNl) : cut;

  return `${trimmed}\n… [catalog truncated]`;
}

async function liveIndex(dir: string, io: IPhaserBriefIo): Promise<string> {
  try {
    const text = await io.readText(join(dir, CATALOG_REL));

    if (text.trim().length > 0) {
      return capCatalog(text);
    }
  } catch {
    // catalog missing — fall through to directory names
  }

  const lines = ["LIVE INDEX (directory names):"];

  for (const rel of INDEX_DIRS) {
    const names = await io.listNames(join(dir, rel));
    const shown = names.length > 0 ? names.join(", ") : "(none)";

    lines.push(`- ${rel}: ${shown}`);
  }

  return lines.join("\n");
}

/** Session-start brief for a Phaser-receipt project. */
export async function phaserContextBrief(
  dir: string,
  io: IPhaserBriefIo = defaultPhaserBriefIo
): Promise<string> {
  const index = await liveIndex(dir, io);

  return `${PHASER_STATIC_BRIEF}\n\nLIVE INDEX:\n${index}`;
}
