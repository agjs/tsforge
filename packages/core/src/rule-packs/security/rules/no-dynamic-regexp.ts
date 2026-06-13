import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-dynamic-regexp";

type MessageIds = "dynamicRegexp";

function isExpression(node: TSESTree.Node): node is TSESTree.Expression {
  return node.type !== AST_NODE_TYPES.SpreadElement;
}

function isStringLiteral(node: TSESTree.Expression): boolean {
  return node.type === AST_NODE_TYPES.Literal && typeof node.value === "string";
}

export const noDynamicRegexpRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow new RegExp(non-literal) — dynamic patterns enable ReDoS. Use string-literal regexes or a safe engine like re2.",
    },
    schema: [],
    messages: {
      dynamicRegexp:
        "Do not construct `RegExp` from a runtime value — use a string-literal pattern or a safe regex library to avoid ReDoS.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      NewExpression(node: TSESTree.NewExpression) {
        const callee = node.callee;

        if (
          callee.type !== AST_NODE_TYPES.Identifier ||
          callee.name !== "RegExp"
        ) {
          return;
        }

        const patternArg = node.arguments[0];

        if (patternArg === undefined || !isExpression(patternArg)) {
          return;
        }

        if (!isStringLiteral(patternArg)) {
          context.report({ node, messageId: "dynamicRegexp" });
        }
      },
    };
  },
});
