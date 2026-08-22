import { createRule } from "../../create-rule";
import {
  analyzePhaserImports,
  classBindsPersistentListeners,
  isPhaserSceneClass,
} from "../utils";

export const RULE_NAME = "require-scene-shutdown-hook";

type MessageIds = "missingShutdownHook";

export const requireSceneShutdownHookRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "A Phaser.Scene that binds persistent listeners must register a SHUTDOWN (or DESTROY) handler so restarts do not leak callbacks.",
    },
    schema: [],
    messages: {
      missingShutdownHook:
        "Scene '{{name}}' binds persistent listeners but never registers `Phaser.Scenes.Events.SHUTDOWN` (or DESTROY). Shutdown is the restart-safe dispose point.",
    },
  },
  defaultOptions: [],
  create(context) {
    let imports = analyzePhaserImports(context.sourceCode.ast);

    return {
      Program(program) {
        imports = analyzePhaserImports(program);
      },
      ClassDeclaration(node) {
        if (!imports.hasPhaserImport) {
          return;
        }

        if (!isPhaserSceneClass(node, imports)) {
          return;
        }

        const { binds, hasShutdownHook } = classBindsPersistentListeners(node);

        if (!binds || hasShutdownHook) {
          return;
        }

        const name = node.id?.name ?? "<anonymous>";

        context.report({
          node: node.id ?? node,
          messageId: "missingShutdownHook",
          data: { name },
        });
      },
    };
  },
});
