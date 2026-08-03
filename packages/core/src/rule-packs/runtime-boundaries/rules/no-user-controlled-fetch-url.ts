import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { hasFixedOrigin, isExpression } from "../../boundary-utils";
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
        "Disallow fetch/axios requests whose ORIGIN is not fixed at author time — a runtime-controlled host enables SSRF.",
    },
    schema: [],
    messages: {
      userControlledFetchUrl:
        "HTTP request URL must have a fixed origin. Use a literal, or a template whose host is author-written before the first `${...}` — `fetch(`/api/todos/${id}`)` is fine; `fetch(url)` and `fetch(`https://${host}/x`)` are not.",
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

        if (!hasFixedOrigin(urlArg)) {
          context.report({ node, messageId: "userControlledFetchUrl" });
        }
      },
    };
  },
});
