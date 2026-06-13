import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-sensitive-next-public-env";

type MessageIds = "sensitiveNextPublic";

const SENSITIVE_NAME = /(?:SECRET|PRIVATE|PASSWORD|TOKEN|DATABASE|STRIPE|KEY)/i;

function isProcessEnvMember(node: TSESTree.MemberExpression): string | null {
  if (node.computed) {
    return null;
  }

  if (
    node.object.type !== AST_NODE_TYPES.MemberExpression ||
    node.object.computed ||
    node.object.object.type !== AST_NODE_TYPES.Identifier ||
    node.object.object.name !== "process" ||
    node.object.property.type !== AST_NODE_TYPES.Identifier ||
    node.object.property.name !== "env"
  ) {
    return null;
  }

  if (node.property.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  return node.property.name;
}

function isSensitiveNextPublicName(name: string): boolean {
  if (!name.startsWith("NEXT_PUBLIC_")) {
    return false;
  }

  return SENSITIVE_NAME.test(name);
}

export const noSensitiveNextPublicEnvRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow NEXT_PUBLIC_* env vars whose names suggest secrets — public build-time vars are visible in the client bundle.",
    },
    schema: [],
    messages: {
      sensitiveNextPublic:
        "`process.env.{{name}}` looks like a secret exposed to the browser — remove NEXT_PUBLIC_ or keep it server-only.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      MemberExpression(node: TSESTree.MemberExpression) {
        const envName = isProcessEnvMember(node);

        if (envName !== null && isSensitiveNextPublicName(envName)) {
          context.report({
            node,
            messageId: "sensitiveNextPublic",
            data: { name: envName },
          });
        }
      },
    };
  },
});
