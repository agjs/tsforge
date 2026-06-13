import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "webhook-must-verify-signature-before-parse";

type MessageIds = "jsonBeforeVerify";

function isWebhookFile(filename: string): boolean {
  const base = filename.split(/[\\/]/).pop() ?? "";

  return base.toLowerCase().includes("webhook");
}

function isVerifyCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  if (callee.type === AST_NODE_TYPES.Identifier) {
    return callee.name === "verify" || callee.name.startsWith("verify");
  }

  if (
    callee.type !== AST_NODE_TYPES.MemberExpression ||
    callee.computed ||
    callee.property.type !== AST_NODE_TYPES.Identifier
  ) {
    return false;
  }

  const name = callee.property.name;

  return (
    name === "constructEvent" || name === "verify" || name.startsWith("verify")
  );
}

function isJsonCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  return (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    callee.property.name === "json"
  );
}

export const webhookMustVerifySignatureBeforeParseRule = createRule<
  [],
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Webhook handlers must verify signatures before calling `.json()` on the request body.",
    },
    schema: [],
    messages: {
      jsonBeforeVerify:
        "Verify the webhook signature (`verify*` or `constructEvent`) before parsing the body with `.json()`.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!isWebhookFile(context.filename)) {
      return {};
    }

    let verifySeen = false;

    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (isVerifyCall(node)) {
          verifySeen = true;

          return;
        }

        if (isJsonCall(node) && !verifySeen) {
          context.report({ node, messageId: "jsonBeforeVerify" });
        }
      },
    };
  },
});
