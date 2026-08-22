import type { IConventionProvider } from "../conventions-provider";
import { makeConventionProvider } from "../conventions";

const TOPICS = [
  "domain-purity",
  "scene-shutdown",
  "no-tick-alloc",
  "branded-keys",
  "composition",
  "content-catalog",
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
};

const GUIDES: Readonly<Record<PhaserConventionTopic, string>> = {
  "domain-purity":
    "DOMAIN PURITY. src/domain, src/content, src/shared, src/features must not import phaser. Phaser stays in src/runtime and src/app. Pure functions + Zod catalogs; the scene is a view.",
  "scene-shutdown":
    "SCENE SHUTDOWN. A Phaser.Scene that binds persistent listeners must register this.events.once(Phaser.Scenes.Events.SHUTDOWN, dispose). Remove game/registry/scale/window listeners yourself — Phaser will not.",
  "no-tick-alloc":
    "NO TICK ALLOC. Do not this.add.*, physics.add.overlap/collider, or this.load.* inside update/tick/preUpdate. Create GameObjects and colliders once in setup. setText in the tick re-uploads a GPU texture.",
  "branded-keys":
    "BRANDED KEYS. scene.start / super(key) / load.image take named constants (WORLD_SCENE_KEY), never string literals.",
  composition:
    "COMPOSITION. Thin Phaser.Scene + setupX() returning { update, dispose }. Ports come from src/app/composition — do not construct adapters in the scene. import * as Phaser from 'phaser'. Never ignoreDestroy = true.",
  "content-catalog":
    "CONTENT CATALOG. Game data lives in src/content JSON + Zod schemas. bun run catalog. Do not hard-code item tables inside a scene.",
};

export const phaserConventionProvider: IConventionProvider =
  makeConventionProvider({
    topics: TOPICS,
    guides: GUIDES,
    topicRules: PHASER_TOPIC_RULES,
  });
