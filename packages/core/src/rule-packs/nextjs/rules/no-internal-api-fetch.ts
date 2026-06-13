import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { calleeName, isServerAppFile } from "../utils";

export const RULE_NAME = "no-internal-api-fetch";

type MessageIds = "internalApiFetch";

function urlLooksLikeInternalApi(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed.startsWith("/api/") || trimmed === "/api") {
    return true;
  }

  return /localhost(?::\d+)?\/api\b/.test(trimmed);
}

function literalApiUrl(node: TSESTree.Expression): boolean {
  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === "string") {
    return urlLooksLikeInternalApi(node.value);
  }

  return false;
}

function templateApiUrl(node: TSESTree.TemplateLiteral): boolean {
  const cooked = node.quasis.map((q) => q.value.cooked ?? "").join("");

  return urlLooksLikeInternalApi(cooked);
}

function firstArgLooksLikeInternalApi(
  args: readonly TSESTree.CallExpressionArgument[]
): boolean {
  const first = args[0];

  if (first === undefined || first.type === AST_NODE_TYPES.SpreadElement) {
    return false;
  }

  if (literalApiUrl(first)) {
    return true;
  }

  if (first.type === AST_NODE_TYPES.TemplateLiteral) {
    return templateApiUrl(first);
  }

  return false;
}

function isFetchCall(node: TSESTree.CallExpression): boolean {
  const name = calleeName(node.callee);

  return name === "fetch";
}

function isAxiosApiCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  if (callee.type !== AST_NODE_TYPES.MemberExpression || callee.computed) {
    return false;
  }

  if (
    callee.object.type !== AST_NODE_TYPES.Identifier ||
    callee.object.name !== "axios"
  ) {
    return false;
  }

  if (callee.property.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }

  const method = callee.property.name;

  return (
    method === "get" ||
    method === "post" ||
    method === "put" ||
    method === "patch" ||
    method === "delete" ||
    method === "request"
  );
}

export const noInternalApiFetchRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Server Components from fetching the app's own /api routes — import services or ORM modules directly to avoid loopback HTTP overhead.",
    },
    schema: [],
    messages: {
      internalApiFetch:
        "Do not fetch `/api/*` from a Server Component — import the data/service module directly instead of loopback HTTP.",
    },
  },
  defaultOptions: [],
  create(context) {
    let serverFile = false;

    return {
      Program(node: TSESTree.Program) {
        serverFile = isServerAppFile(context.filename, node);
      },
      CallExpression(node: TSESTree.CallExpression) {
        if (!serverFile) {
          return;
        }

        if (
          (isFetchCall(node) || isAxiosApiCall(node)) &&
          firstArgLooksLikeInternalApi(node.arguments)
        ) {
          context.report({ node, messageId: "internalApiFetch" });
        }
      },
    };
  },
});
