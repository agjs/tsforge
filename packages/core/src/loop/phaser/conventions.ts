import type { IConventionProvider } from "../conventions-provider";
import {
  HOUSE_TOPIC_RULES,
  houseConventionGuide,
  makeConventionProvider,
} from "../conventions";

const TOPICS = [
  "domain-purity",
  "scene-shutdown",
  "no-tick-alloc",
  "branded-keys",
  "composition",
  "content-catalog",
  "module-layout",
  "testing",
  "no-casts",
  "lint-gotchas",
] as const;

export type PhaserConventionTopic = (typeof TOPICS)[number];

export const PHASER_TOPIC_RULES: Readonly<
  Record<PhaserConventionTopic, readonly string[]>
> = {
  "domain-purity": ["no-phaser-import-in-pure-layers"],
  "scene-shutdown": [
    "require-scene-shutdown-hook",
    "no-unmanaged-global-listeners",
  ],
  "no-tick-alloc": [
    "no-phaser-alloc-in-update",
    "no-physics-collider-in-update",
    "no-loader-in-update",
  ],
  "branded-keys": ["no-raw-scene-key-literal", "no-raw-texture-key-literal"],
  composition: ["no-ignore-destroy", "require-scene-shutdown-hook"],
  "content-catalog": [],
  "module-layout": [],
  testing: HOUSE_TOPIC_RULES.testing,
  "no-casts": HOUSE_TOPIC_RULES["no-casts"],
  "lint-gotchas": HOUSE_TOPIC_RULES["lint-gotchas"],
};

const GUIDES: Readonly<Record<PhaserConventionTopic, string>> = {
  "domain-purity":
    "DOMAIN PURITY. src/domain, src/content, src/shared, src/features must not import phaser. Phaser stays in src/runtime and src/app. bun run new:module -- Coin then fill Coin.behavior.ts (pure transitions) + Coin.test.ts. Do not grow WorldScene.ts with game rules.",
  "scene-shutdown":
    "SCENE SHUTDOWN. A Phaser.Scene that binds persistent listeners must register this.events.once(Phaser.Scenes.Events.SHUTDOWN, dispose). WorldScene already does this in create(). Remove game/registry/scale/window listeners yourself — Phaser will not. Never ignoreDestroy = true.",
  "no-tick-alloc":
    "NO TICK ALLOC. Do not this.add.*, physics.add.overlap/collider, or this.load.* inside update/tick/preUpdate. Create GameObjects and colliders once in setup. Tick may setPosition / setText on existing objects; setText still re-uploads a GPU texture — prefer a bitmap/text object created in setup.",
  "branded-keys":
    "BRANDED KEYS. scene.start / super(key) / load.image take named constants (WORLD_SCENE_KEY from WorldScene.constants.ts), never string literals.",
  composition:
    "COMPOSITION. Features: bun run new:feature -- Coin then createCoinFeature(deps) → { dispose }. Wire in the target scene setup (World → src/runtime/phaser/scenes/WorldScene/WorldScene.setup.ts) next to createMovementFeature; dispose() in dispose. Scenes: bun run new:scene -- ShopScene then register in src/app/config/gameConfig.ts scene: [BootScene, WorldScene, ShopScene] — Boot stays first. Ports: construct only in src/app/composition/composeRuntime.ts. import * as Phaser from 'phaser'. Never ignoreDestroy = true.",
  "content-catalog":
    "CONTENT CATALOG. bun run new:content -- Coin. Zod schema + kebab ids under src/content. bun run catalog after. Do not hard-code item tables inside a scene.",
  "module-layout":
    "MODULE LAYOUT. bun run new:module -- Coin. Fill the 8-file domain layout: Coin.types.ts, Coin.model.ts, Coin.behavior.ts (pure transitions), Coin.constants.ts, Coin.system.ts, Coin.contracts.ts, Coin.test.ts, index.ts. No phaser import. Do not invent a different suffix set.",
  testing: `${houseConventionGuide("testing")} Phaser overlay: domain tests use createX factories and stay Phaser-free. Feature tests use fakes from src/shared/testing. Co-locate *.test.ts next to the unit.`,
  "no-casts": houseConventionGuide("no-casts"),
  "lint-gotchas": houseConventionGuide("lint-gotchas"),
};

function normPath(file: string): string {
  return file.replaceAll("\\", "/");
}

function inDir(norm: string, dir: string): boolean {
  return norm === dir || norm.startsWith(`${dir}/`);
}

/**
 * Phaser path → topics. Probe samples in PHASER_PATH_PROBES call this same
 * function so the pull-contract table cannot drift.
 */
export function phaserTopicsForPath(file: string): readonly string[] {
  const norm = normPath(file);
  const topics: string[] = [];

  const add = (topic: string): void => {
    if (!topics.includes(topic)) {
      topics.push(topic);
    }
  };

  if (norm.includes(".test.") || norm.includes(".spec.")) {
    add("testing");
  }

  if (inDir(norm, "src/domain") || norm.includes("/src/domain/")) {
    add("domain-purity");
    add("module-layout");
    add("testing");
    add("no-casts");

    return topics;
  }

  if (inDir(norm, "src/features") || norm.includes("/src/features/")) {
    add("domain-purity");
    add("composition");
    add("testing");
    add("no-casts");

    return topics;
  }

  if (
    inDir(norm, "src/runtime/phaser/scenes") ||
    norm.includes("/src/runtime/phaser/scenes/")
  ) {
    add("composition");
    add("scene-shutdown");
    add("no-tick-alloc");
    add("branded-keys");

    return topics;
  }

  if (
    inDir(norm, "src/runtime/phaser/entities") ||
    norm.includes("/src/runtime/phaser/entities/")
  ) {
    add("composition");
    add("no-tick-alloc");
    add("branded-keys");

    return topics;
  }

  if (
    inDir(norm, "src/runtime/adapters") ||
    norm.includes("/src/runtime/adapters/") ||
    inDir(norm, "src/app/composition") ||
    norm.includes("/src/app/composition/")
  ) {
    add("composition");

    return topics;
  }

  if (inDir(norm, "src/content") || norm.includes("/src/content/")) {
    add("content-catalog");
    add("no-casts");

    return topics;
  }

  if (
    norm === "src/shared/types/ports.ts" ||
    norm.endsWith("/src/shared/types/ports.ts")
  ) {
    add("composition");

    return topics;
  }

  if (norm.endsWith(".ts") || norm.endsWith(".tsx")) {
    add("no-casts");
    add("lint-gotchas");
  }

  return topics;
}

export const PHASER_PATH_PROBES: readonly {
  readonly label: string;
  readonly sample: string;
}[] = [
  { label: "src/domain/**", sample: "src/domain/coin/Coin.behavior.ts" },
  { label: "src/features/**", sample: "src/features/coin/CoinFeature.ts" },
  {
    label: "src/runtime/phaser/scenes/**",
    sample: "src/runtime/phaser/scenes/WorldScene/WorldScene.setup.ts",
  },
  {
    label: "src/runtime/phaser/entities/**",
    sample: "src/runtime/phaser/entities/PlayerEntity.ts",
  },
  {
    label: "src/runtime/adapters/**",
    sample: "src/runtime/adapters/browserTime.port.ts",
  },
  {
    label: "src/app/composition/**",
    sample: "src/app/composition/composeRuntime.ts",
  },
  { label: "src/content/**", sample: "src/content/schemas/item.schema.ts" },
  {
    label: "src/shared/types/ports.ts",
    sample: "src/shared/types/ports.ts",
  },
  { label: "*.test.*", sample: "src/domain/coin/Coin.test.ts" },
];

export const phaserConventionProvider: IConventionProvider =
  makeConventionProvider({
    topics: TOPICS,
    guides: GUIDES,
    topicRules: PHASER_TOPIC_RULES,
    topicsForPath: phaserTopicsForPath,
    pathProbes: PHASER_PATH_PROBES,
  });
