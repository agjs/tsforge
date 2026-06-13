import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-anonymous-useEffect";

type MessageIds = "anonymousEffect";

function isUseEffectCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  if (
    callee.type === AST_NODE_TYPES.Identifier &&
    callee.name === "useEffect"
  ) {
    return true;
  }

  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    callee.property.name === "useEffect"
  ) {
    return true;
  }

  return false;
}

export const noAnonymousUseEffectRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow anonymous arrow functions passed to useEffect — use a named function for debuggable stack traces.",
    },
    schema: [],
    messages: {
      anonymousEffect:
        "Pass a named function to `useEffect` (e.g. `useEffect(function syncSession() { ... }, deps)`) instead of an anonymous arrow.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (!isUseEffectCall(node)) {
          return;
        }

        const effectFn = node.arguments[0];

        if (effectFn?.type === AST_NODE_TYPES.ArrowFunctionExpression) {
          context.report({ node: effectFn, messageId: "anonymousEffect" });
        }
      },
    };
  },
});
