import type { TSESLint } from "@typescript-eslint/utils";

import { noGlobalPhaserRule } from "./rules/no-global-phaser";
import { noIgnoreDestroyRule } from "./rules/no-ignore-destroy";
import { noLoaderInUpdateRule } from "./rules/no-loader-in-update";
import { noPhaserAllocInUpdateRule } from "./rules/no-phaser-alloc-in-update";
import { noPhaserImportInPureLayersRule } from "./rules/no-phaser-import-in-pure-layers";
import { noPhysicsColliderInUpdateRule } from "./rules/no-physics-collider-in-update";
import { noRawSceneKeyLiteralRule } from "./rules/no-raw-scene-key-literal";
import { noRawTextureKeyLiteralRule } from "./rules/no-raw-texture-key-literal";
import { noUnmanagedGlobalListenersRule } from "./rules/no-unmanaged-global-listeners";
import { requireSceneShutdownHookRule } from "./rules/require-scene-shutdown-hook";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "no-global-phaser": noGlobalPhaserRule,
  "no-ignore-destroy": noIgnoreDestroyRule,
  "no-loader-in-update": noLoaderInUpdateRule,
  "no-phaser-alloc-in-update": noPhaserAllocInUpdateRule,
  "no-phaser-import-in-pure-layers": noPhaserImportInPureLayersRule,
  "no-physics-collider-in-update": noPhysicsColliderInUpdateRule,
  "no-raw-scene-key-literal": noRawSceneKeyLiteralRule,
  "no-raw-texture-key-literal": noRawTextureKeyLiteralRule,
  "no-unmanaged-global-listeners": noUnmanagedGlobalListenersRule,
  "require-scene-shutdown-hook": requireSceneShutdownHookRule,
};

export const phaserPack: IRulePack = {
  id: "phaser",
  description:
    "Phaser 4 as a render substrate: scene shutdown ownership, no global emitter leaks, no Phaser factories in the tick, branded scene/texture keys",
  rules,
  rulesConfig: {
    "no-global-phaser": "warn",
    "no-ignore-destroy": "error",
    "no-loader-in-update": "error",
    "no-phaser-alloc-in-update": "warn",
    "no-phaser-import-in-pure-layers": "error",
    "no-physics-collider-in-update": "error",
    "no-raw-scene-key-literal": "error",
    "no-raw-texture-key-literal": "warn",
    "no-unmanaged-global-listeners": "error",
    "require-scene-shutdown-hook": "error",
  },
};

export default phaserPack;
