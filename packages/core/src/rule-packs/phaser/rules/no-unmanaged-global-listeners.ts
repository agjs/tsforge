import { createRule } from "../../create-rule";
import {
  analyzePhaserImports,
  isForbiddenGlobalListener,
  isPhaserSceneClass,
} from "../utils";

export const RULE_NAME = "no-unmanaged-global-listeners";

type MessageIds = "unmanagedGlobal";

export const noUnmanagedGlobalListenersRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Do not attach window/document/Game/Registry/Scale/Animation/Texture listeners from a Phaser.Scene. Scene-owned emitters are cleaned on shutdown; game-lifetime emitters belong in app bootstrap.",
    },
    schema: [],
    messages: {
      unmanagedGlobal:
        "Do not subscribe to window, document, Game, Registry, Scale, Animation, or Texture emitters from a Scene. Use `this.events` / `this.input` (scene-owned) or bind game-lifetime listeners in app bootstrap.",
    },
  },
  defaultOptions: [],
  create(context) {
    let imports = analyzePhaserImports(context.sourceCode.ast);
    let sceneDepth = 0;

    return {
      Program(program) {
        imports = analyzePhaserImports(program);
      },
      ClassDeclaration(node) {
        if (isPhaserSceneClass(node, imports)) {
          sceneDepth += 1;
        }
      },
      "ClassDeclaration:exit"(node) {
        if (isPhaserSceneClass(node, imports) && sceneDepth > 0) {
          sceneDepth -= 1;
        }
      },
      CallExpression(node) {
        if (!imports.hasPhaserImport || sceneDepth === 0) {
          return;
        }

        if (!isForbiddenGlobalListener(node)) {
          return;
        }

        context.report({ node, messageId: "unmanagedGlobal" });
      },
    };
  },
});
