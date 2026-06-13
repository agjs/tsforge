import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { nodeContainsCallNamed } from "../utils/fastifyChain";

export const RULE_NAME = "error-handler-must-set-status";

type MessageIds = "missingReplyCode";

function isSetErrorHandlerCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  return (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    callee.property.name === "setErrorHandler"
  );
}

function handlerSetsStatus(
  handler:
    | TSESTree.ArrowFunctionExpression
    | TSESTree.FunctionExpression
    | TSESTree.FunctionDeclaration
): boolean {
  const body = handler.body;

  if (body.type === AST_NODE_TYPES.BlockStatement) {
    for (const stmt of body.body) {
      if (nodeContainsCallNamed(stmt, "reply", "code")) {
        return true;
      }

      if (nodeContainsCallNamed(stmt, "reply", "status")) {
        return true;
      }
    }
  }

  return false;
}

export const errorHandlerMustSetStatusRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Custom Fastify setErrorHandler callbacks must call reply.code() or reply.status() — automatic status mapping is disabled when a custom handler is registered.",
    },
    schema: [],
    messages: {
      missingReplyCode:
        "Custom `setErrorHandler` must call `reply.code(...)` (or `reply.status(...)`) before sending — Fastify does not auto-map status codes in custom error handlers.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (!isSetErrorHandlerCall(node)) {
          return;
        }

        for (const arg of node.arguments) {
          if (
            (arg.type === AST_NODE_TYPES.ArrowFunctionExpression ||
              arg.type === AST_NODE_TYPES.FunctionExpression) &&
            !handlerSetsStatus(arg)
          ) {
            context.report({ node: arg, messageId: "missingReplyCode" });
          }
        }
      },
    };
  },
});
