import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-conditional-expect";

type MessageIds = "conditionalExpect";

const CONDITIONAL_PARENTS = new Set([
  AST_NODE_TYPES.IfStatement,
  AST_NODE_TYPES.ForStatement,
  AST_NODE_TYPES.ForInStatement,
  AST_NODE_TYPES.ForOfStatement,
  AST_NODE_TYPES.WhileStatement,
  AST_NODE_TYPES.DoWhileStatement,
  AST_NODE_TYPES.SwitchCase,
  AST_NODE_TYPES.ConditionalExpression,
]);

function isExpectCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  if (callee.type === AST_NODE_TYPES.Identifier) {
    return callee.name === "expect";
  }

  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    callee.property.name === "expect"
  ) {
    return true;
  }

  return false;
}

function isInsideConditional(node: TSESTree.Node): boolean {
  let current = node.parent;

  while (current !== undefined && current !== null) {
    if (CONDITIONAL_PARENTS.has(current.type)) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

export const noConditionalExpectRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `expect()` inside conditionals — tests must fail when assertions are skipped.",
    },
    schema: [],
    messages: {
      conditionalExpect:
        "Do not call `expect()` inside a conditional — skipped assertions hide regressions.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        if (isExpectCall(node) && isInsideConditional(node)) {
          context.report({ node, messageId: "conditionalExpect" });
        }
      },
    };
  },
});
