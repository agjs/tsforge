import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-throw-literal";

type MessageIds = "throwLiteral";

function isErrorConstruction(node: TSESTree.Expression): boolean {
  if (node.type === AST_NODE_TYPES.NewExpression) {
    const callee = node.callee;

    if (callee.type === AST_NODE_TYPES.Identifier && callee.name === "Error") {
      return true;
    }

    if (
      callee.type === AST_NODE_TYPES.MemberExpression &&
      !callee.computed &&
      callee.property.type === AST_NODE_TYPES.Identifier &&
      callee.property.name === "Error"
    ) {
      return true;
    }
  }

  return false;
}

export const noThrowLiteralRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow throwing primitive literals (strings, numbers) — throw Error instances so error handlers can propagate status and stack traces correctly.",
    },
    schema: [],
    messages: {
      throwLiteral:
        "Do not throw a literal value — throw an `Error` instance (e.g. `throw new Error('...')`) so framework error handlers can propagate it correctly.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ThrowStatement(node: TSESTree.ThrowStatement) {
        const argument = node.argument;

        if (argument === null) {
          return;
        }

        if (isErrorConstruction(argument)) {
          return;
        }

        if (
          argument.type === AST_NODE_TYPES.Literal ||
          argument.type === AST_NODE_TYPES.TemplateLiteral
        ) {
          context.report({ node, messageId: "throwLiteral" });
        }
      },
    };
  },
});
