import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-auth-token-in-storage";

type MessageIds = "authTokenInStorage";

const SENSITIVE_KEY = /(?:token|session|auth|jwt)/i;

function isBrowserStorageObject(
  node: TSESTree.Node
): node is TSESTree.Identifier {
  return (
    node.type === AST_NODE_TYPES.Identifier &&
    (node.name === "localStorage" || node.name === "sessionStorage")
  );
}

function storageMethodName(node: TSESTree.CallExpression): string | null {
  const callee = node.callee;

  if (
    callee.type !== AST_NODE_TYPES.MemberExpression ||
    callee.computed ||
    !isBrowserStorageObject(callee.object) ||
    callee.property.type !== AST_NODE_TYPES.Identifier
  ) {
    return null;
  }

  const method = callee.property.name;

  if (method !== "setItem" && method !== "getItem") {
    return null;
  }

  return method;
}

function keyLooksSensitive(arg: TSESTree.Expression): boolean {
  if (arg.type === AST_NODE_TYPES.Literal && typeof arg.value === "string") {
    return SENSITIVE_KEY.test(arg.value);
  }

  if (arg.type === AST_NODE_TYPES.Identifier) {
    return SENSITIVE_KEY.test(arg.name);
  }

  return false;
}

export const noAuthTokenInStorageRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow storing or reading auth tokens from localStorage/sessionStorage — use httpOnly cookies instead.",
    },
    schema: [],
    messages: {
      authTokenInStorage:
        "Do not store auth tokens in `{{storage}}` — use httpOnly, secure cookies so XSS cannot exfiltrate sessions.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const method = storageMethodName(node);

        if (method === null) {
          return;
        }

        const keyArg = node.arguments[0];

        if (
          keyArg === undefined ||
          keyArg.type === AST_NODE_TYPES.SpreadElement ||
          !keyLooksSensitive(keyArg)
        ) {
          return;
        }

        const callee = node.callee;

        if (callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        const storageObject = callee.object;

        if (!isBrowserStorageObject(storageObject)) {
          return;
        }

        context.report({
          node,
          messageId: "authTokenInStorage",
          data: { storage: storageObject.name },
        });
      },
    };
  },
});
