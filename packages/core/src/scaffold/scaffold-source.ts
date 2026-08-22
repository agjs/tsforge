import type { IArchetype, IScaffoldManifest } from "./scaffold.types";
import { loadBundledManifest } from "./boringstack-manifest";
import { loadPhaserTemplate } from "./phaser-manifest";

/**
 * Pick the clone source for an archetype and apply `--ref` / repo env overrides.
 * `BORINGSTACK_REPO` / `PHASER_TEMPLATE_REPO` let dogfood clone a local checkout.
 */
export function loadScaffoldSource(
  archetype: IArchetype,
  ref = ""
): IScaffoldManifest {
  const base =
    archetype === "phaser" ? loadPhaserTemplate() : loadBundledManifest();
  const repoEnv =
    archetype === "phaser"
      ? process.env.PHASER_TEMPLATE_REPO
      : process.env.BORINGSTACK_REPO;

  return {
    ...base,
    ...(ref.length > 0 ? { defaultRef: ref } : {}),
    ...(repoEnv !== undefined && repoEnv.length > 0 ? { repo: repoEnv } : {}),
  };
}
