import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { isExpression, isStringLiteral } from "../../boundary-utils";
import { createRule } from "../../create-rule";

export const RULE_NAME = "no-user-controlled-fetch-url";

type MessageIds = "userControlledFetchUrl";

const AXIOS_HTTP_METHODS = new Set(["get", "post"]);

function isFetchCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  return callee.type === AST_NODE_TYPES.Identifier && callee.name === "fetch";
}

function isAxiosHttpCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  if (
    callee.type !== AST_NODE_TYPES.MemberExpression ||
    callee.computed ||
    callee.property.type !== AST_NODE_TYPES.Identifier ||
    !AXIOS_HTTP_METHODS.has(callee.property.name)
  ) {
    return false;
  }

  const object = callee.object;

  return object.type === AST_NODE_TYPES.Identifier && object.name === "axios";
}

export const noUserControlledFetchUrlRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow fetch/axios requests to non-literal URLs — dynamic URLs enable SSRF.",
    },
    schema: [],
    messages: {
      userControlledFetchUrl:
        "HTTP request URL must be a string literal — do not pass user-controlled values to `fetch()` or `axios`.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (!isFetchCall(node) && !isAxiosHttpCall(node)) {
          return;
        }

        const urlArg = node.arguments[0];

        if (urlArg === undefined || !isExpression(urlArg)) {
          return;
        }

        if (!isStringLiteral(urlArg)) {
          context.report({ node, messageId: "userControlledFetchUrl" });
        }
      },
    };
  },
});
