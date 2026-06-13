import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { isExpression, isStringLiteral } from "../../boundary-utils";
import { createRule } from "../../create-rule";

export const RULE_NAME = "no-user-controlled-redirect";

type MessageIds = "userControlledRedirect";

function isRedirectCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  if (callee.type === AST_NODE_TYPES.Identifier && callee.name === "redirect") {
    return true;
  }

  if (
    callee.type !== AST_NODE_TYPES.MemberExpression ||
    callee.computed ||
    callee.property.type !== AST_NODE_TYPES.Identifier ||
    callee.property.name !== "redirect"
  ) {
    return false;
  }

  const object = callee.object;

  if (
    object.type === AST_NODE_TYPES.Identifier &&
    (object.name === "reply" || object.name === "NextResponse")
  ) {
    return true;
  }

  return (
    object.type === AST_NODE_TYPES.MemberExpression &&
    !object.computed &&
    object.object.type === AST_NODE_TYPES.Identifier &&
    object.object.name === "NextResponse" &&
    object.property.type === AST_NODE_TYPES.Identifier &&
    object.property.name === "redirect"
  );
}

export const noUserControlledRedirectRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow redirects to non-literal URLs — user-controlled redirects enable open redirects.",
    },
    schema: [],
    messages: {
      userControlledRedirect:
        "Redirect URL must be a string literal — do not pass user-controlled values to `redirect()`.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (!isRedirectCall(node)) {
          return;
        }

        const urlArg = node.arguments[0];

        if (urlArg === undefined || !isExpression(urlArg)) {
          return;
        }

        if (!isStringLiteral(urlArg)) {
          context.report({ node, messageId: "userControlledRedirect" });
        }
      },
    };
  },
});
