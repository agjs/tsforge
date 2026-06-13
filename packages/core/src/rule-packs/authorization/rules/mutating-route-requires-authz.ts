import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  authzOptionSchema,
  containsAuthzCall,
  defaultAuthzOptions,
  getExportedMutatingHandlerName,
  getFunctionLikeBody,
  isRouteHandlerFile,
  resolveAuthzFunctions,
  type AuthzRuleOptions,
  type FunctionLike,
} from "../utils";

export const RULE_NAME = "mutating-route-requires-authz";

type MessageIds = "missingAuthz";

function getHandlerFunction(node: TSESTree.Node): FunctionLike | null {
  if (node.type === AST_NODE_TYPES.ExportNamedDeclaration) {
    const declaration = node.declaration;

    if (
      declaration?.type === AST_NODE_TYPES.FunctionDeclaration &&
      declaration.body !== null
    ) {
      return declaration;
    }

    if (declaration?.type === AST_NODE_TYPES.VariableDeclaration) {
      for (const declarator of declaration.declarations) {
        const init = declarator.init;

        if (
          init?.type === AST_NODE_TYPES.FunctionExpression ||
          init?.type === AST_NODE_TYPES.ArrowFunctionExpression
        ) {
          return init;
        }
      }
    }

    return null;
  }

  if (node.type === AST_NODE_TYPES.FunctionDeclaration && node.body !== null) {
    return node;
  }

  return null;
}

export const mutatingRouteRequiresAuthzRule = createRule<
  AuthzRuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "POST/PUT/PATCH/DELETE route handlers must call an authorization helper before mutating state.",
    },
    schema: [authzOptionSchema],
    messages: {
      missingAuthz:
        "Mutating route handler `{{method}}` must call an authorization helper (e.g. {{examples}}) before performing writes.",
    },
  },
  defaultOptions: [defaultAuthzOptions()],
  create(context, [options]) {
    const authzNames = resolveAuthzFunctions(options);
    const examples = [...authzNames].slice(0, 2).join(", ");

    function reportMissingAuthz(node: TSESTree.Node, method: string): void {
      context.report({
        node,
        messageId: "missingAuthz",
        data: { method, examples },
      });
    }

    function checkHandler(exportNode: TSESTree.Node, method: string): void {
      const handler = getHandlerFunction(exportNode);

      if (handler === null) {
        return;
      }

      const body = getFunctionLikeBody(handler);

      if (body === null || containsAuthzCall(body, authzNames)) {
        return;
      }

      reportMissingAuthz(exportNode, method);
    }

    return {
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration) {
        if (!isRouteHandlerFile(context.filename)) {
          return;
        }

        const method = getExportedMutatingHandlerName(node);

        if (method === null) {
          return;
        }

        checkHandler(node, method);
      },
    };
  },
});
