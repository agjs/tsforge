import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-component-invocation";

type MessageIds = "componentInvocation";

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

export const noComponentInvocationRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow invoking React components as plain functions — use JSX (`<Header />`) instead of `{Header()}`.",
    },
    schema: [],
    messages: {
      componentInvocation:
        "Do not call `{{name}}()` as a function — render it as JSX: `<{{name}} />`.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXExpressionContainer(node: TSESTree.JSXExpressionContainer) {
        const expression = node.expression;

        if (expression.type !== AST_NODE_TYPES.CallExpression) {
          return;
        }

        const callee = expression.callee;

        if (callee.type !== AST_NODE_TYPES.Identifier) {
          return;
        }

        if (!isComponentName(callee.name)) {
          return;
        }

        context.report({
          node: expression,
          messageId: "componentInvocation",
          data: { name: callee.name },
        });
      },
    };
  },
});
