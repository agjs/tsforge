import { AST_NODE_TYPES } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  analyzePhaserImports,
  createHotPathTracker,
  hotPathVisitors,
  isAddFactoryCall,
  isPhaserNamespacedNew,
  isPhysicsAddCtorCall,
  isTextMutationCall,
  memberChain,
} from "../utils";

export const RULE_NAME = "no-phaser-alloc-in-update";

type MessageIds = "factoryInUpdate" | "ctorInUpdate" | "textInUpdate";

export const noPhaserAllocInUpdateRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Do not construct Phaser GameObjects, Geom, or Math objects inside update/tick/preUpdate. Preallocate or pool; setText in the tick re-uploads a GPU texture.",
    },
    schema: [],
    messages: {
      factoryInUpdate:
        "Do not call `add`/`make`/`physics.add` factories inside `update`/`tick`. Create GameObjects once and reuse them.",
      ctorInUpdate:
        "Do not construct Phaser Math/Geom/GameObject instances inside `update`/`tick`. Use a preallocated buffer or pool.",
      textInUpdate:
        "Do not call `setText`/`setStyle` inside `update`/`tick` — Phaser 4 re-uploads the whole text texture. Update only when the string changes.",
    },
  },
  defaultOptions: [],
  create(context) {
    let imports = analyzePhaserImports(context.sourceCode.ast);
    const hot = createHotPathTracker();

    return {
      Program(program) {
        imports = analyzePhaserImports(program);
      },
      ...hotPathVisitors(hot),
      NewExpression(node) {
        if (!imports.hasPhaserImport || !hot.isInHotPath()) {
          return;
        }

        if (!isPhaserNamespacedNew(node, imports)) {
          return;
        }

        context.report({ node, messageId: "ctorInUpdate" });
      },
      CallExpression(node) {
        if (!imports.hasPhaserImport || !hot.isInHotPath()) {
          return;
        }

        if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        const chain = memberChain(node.callee);

        if (isTextMutationCall(chain)) {
          context.report({ node, messageId: "textInUpdate" });

          return;
        }

        if (isAddFactoryCall(chain) || isPhysicsAddCtorCall(chain)) {
          context.report({ node, messageId: "factoryInUpdate" });
        }
      },
    };
  },
});
