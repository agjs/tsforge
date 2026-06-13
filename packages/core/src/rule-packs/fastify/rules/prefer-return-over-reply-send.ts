import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  collectFastifyVariables,
  getRouteHandler,
  getRouteMethodName,
} from "../utils/fastifyChain";

export const RULE_NAME = "prefer-return-over-reply-send";

type MessageIds = "preferReturn";

function isReplySendReturn(node: TSESTree.ReturnStatement): boolean {
  const arg = node.argument;

  if (arg?.type !== AST_NODE_TYPES.CallExpression) {
    return false;
  }

  const callee = arg.callee;

  return (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.object.type === AST_NODE_TYPES.Identifier &&
    callee.object.name === "reply" &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    callee.property.name === "send"
  );
}

export const preferReturnOverReplySendRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Inside Fastify route handlers, prefer `return data` over `return reply.send(data)` so fast-json-stringify can serialize responses.",
    },
    schema: [],
    messages: {
      preferReturn:
        "Return the payload directly instead of `reply.send(...)` — Fastify serializes returned values when a response schema is defined.",
    },
  },
  defaultOptions: [],
  create(context) {
    let fastifyVars = new Set<string>();

    return {
      Program(program: TSESTree.Program) {
        fastifyVars = collectFastifyVariables(program);
      },
      ReturnStatement(node: TSESTree.ReturnStatement) {
        if (!isReplySendReturn(node)) {
          return;
        }

        let parent: TSESTree.Node | undefined = node.parent;

        while (parent) {
          if (
            parent.type === AST_NODE_TYPES.ArrowFunctionExpression ||
            parent.type === AST_NODE_TYPES.FunctionExpression
          ) {
            break;
          }

          parent = parent.parent;
        }

        if (parent === undefined) {
          return;
        }

        let routeCall: TSESTree.CallExpression | null = null;
        let cursor: TSESTree.Node | undefined = parent.parent;

        while (cursor) {
          if (cursor.type === AST_NODE_TYPES.CallExpression) {
            routeCall = cursor;
            break;
          }

          cursor = cursor.parent;
        }

        if (routeCall === null) {
          return;
        }

        const method = getRouteMethodName(routeCall, fastifyVars);
        const handler = getRouteHandler(routeCall);

        if (method === null || handler !== parent) {
          return;
        }

        context.report({ node, messageId: "preferReturn" });
      },
    };
  },
});
