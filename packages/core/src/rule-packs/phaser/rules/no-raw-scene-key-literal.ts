import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  analyzePhaserImports,
  isPhaserSceneClass,
  isScenePluginCall,
  memberChain,
  stringLiteralValue,
} from "../utils";

export const RULE_NAME = "no-raw-scene-key-literal";

type MessageIds = "rawSceneKey" | "rawSuperKey";

export const noRawSceneKeyLiteralRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Pass scene keys as named constants, not string literals, to scene.start/launch/stop and Scene constructors.",
    },
    schema: [],
    messages: {
      rawSceneKey:
        "Do not pass a string literal to `scene.{{method}}`. Use a named scene-key constant.",
      rawSuperKey:
        "Do not pass a string literal to `super()`. Use a named scene-key constant.",
    },
  },
  defaultOptions: [],
  create(context) {
    let imports = analyzePhaserImports(context.sourceCode.ast);

    return {
      Program(program) {
        imports = analyzePhaserImports(program);
      },
      CallExpression(node) {
        if (!imports.hasPhaserImport) {
          return;
        }

        if (node.callee.type === AST_NODE_TYPES.Super) {
          reportSuperLiteral(node, imports);

          return;
        }

        if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        const chain = memberChain(node.callee);

        if (!isScenePluginCall(chain)) {
          return;
        }

        const keyArg = node.arguments[0];

        if (stringLiteralValue(keyArg) === null) {
          return;
        }

        const method = chain[chain.length - 1];

        context.report({
          node: keyArg ?? node,
          messageId: "rawSceneKey",
          data: { method: method ?? "start" },
        });
      },
    };

    function reportSuperLiteral(
      node: TSESTree.CallExpression,
      currentImports: typeof imports
    ): void {
      const keyArg = node.arguments[0];

      if (stringLiteralValue(keyArg) === null) {
        return;
      }

      const cls = enclosingClass(node);

      if (cls === null || !isPhaserSceneClass(cls, currentImports)) {
        return;
      }

      context.report({
        node: keyArg ?? node,
        messageId: "rawSuperKey",
      });
    }
  },
});

function enclosingClass(
  node: TSESTree.Node
): TSESTree.ClassDeclaration | TSESTree.ClassExpression | null {
  let current: TSESTree.Node | undefined = node.parent;

  while (current !== undefined) {
    if (
      current.type === AST_NODE_TYPES.ClassDeclaration ||
      current.type === AST_NODE_TYPES.ClassExpression
    ) {
      return current;
    }

    current = current.parent;
  }

  return null;
}
