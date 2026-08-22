import { AST_NODE_TYPES } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { analyzePhaserImports, isLiteralTrue } from "../utils";

export const RULE_NAME = "no-ignore-destroy";

type MessageIds = "ignoreDestroy";

export const noIgnoreDestroyRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Do not set GameObject.ignoreDestroy. Scene/Group destroy will skip the object and you own the reference forever.",
    },
    schema: [],
    messages: {
      ignoreDestroy:
        "Do not set `ignoreDestroy`. Keep cross-scene objects in a game-lifetime service, or pool them.",
    },
  },
  defaultOptions: [],
  create(context) {
    let imports = analyzePhaserImports(context.sourceCode.ast);

    return {
      Program(program) {
        imports = analyzePhaserImports(program);
      },
      AssignmentExpression(node) {
        if (!imports.hasPhaserImport) {
          return;
        }

        if (node.left.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        if (
          node.left.computed ||
          node.left.property.type !== AST_NODE_TYPES.Identifier
        ) {
          return;
        }

        if (node.left.property.name !== "ignoreDestroy") {
          return;
        }

        if (!isLiteralTrue(node.right)) {
          return;
        }

        context.report({ node, messageId: "ignoreDestroy" });
      },
      Property(node) {
        if (!imports.hasPhaserImport) {
          return;
        }

        if (node.computed || node.key.type !== AST_NODE_TYPES.Identifier) {
          return;
        }

        if (node.key.name !== "ignoreDestroy") {
          return;
        }

        if (!isLiteralTrue(node.value)) {
          return;
        }

        context.report({ node, messageId: "ignoreDestroy" });
      },
    };
  },
});
