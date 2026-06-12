import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  collectElysiaVariables,
  findEnclosingRouteHandler,
} from "../utils/elysiaChain";

export const RULE_NAME = "prefer-throw-status";

export interface PreferThrowStatusOptions {
  readonly maxStatements?: number;
}

type RuleOptions = [PreferThrowStatusOptions];
type MessageIds = "preferThrowStatus";

const DEFAULT_MAX_STATEMENTS = 3;

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    maxStatements: { type: "integer", minimum: 1 },
  },
};

export const preferThrowStatusRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Inside Elysia route handlers, prefer `throw status(...)` over try/catch blocks that build their own Response — local catches bypass Elysia's typed onError pipeline.",
    },
    schema: [optionSchema],
    messages: {
      preferThrowStatus:
        "Avoid wrapping route logic in a try/catch that builds its own response. Use `throw status(code, message)` (or your project's typed exception) so Elysia's onError pipeline can render a typed response.",
    },
  },
  defaultOptions: [{ maxStatements: DEFAULT_MAX_STATEMENTS }],
  create(context, [options]) {
    const maxStatements = options.maxStatements ?? DEFAULT_MAX_STATEMENTS;
    let elysiaVars = new Set<string>();

    return {
      Program(program) {
        elysiaVars = collectElysiaVariables(program);
      },
      TryStatement(node) {
        if (!findEnclosingRouteHandler(node, elysiaVars)) {
          return;
        }

        const tooLargeTry = node.block.body.length > maxStatements;
        const catchProducesResponse = node.handler
          ? catchBuildsResponse(node.handler.body)
          : false;

        if (!tooLargeTry && !catchProducesResponse) {
          return;
        }

        context.report({ node, messageId: "preferThrowStatus" });
      },
    };
  },
});

function catchBuildsResponse(block: TSESTree.BlockStatement): boolean {
  for (const stmt of block.body) {
    if (statementBuildsResponse(stmt)) {
      return true;
    }
  }

  return false;
}

function statementBuildsResponse(stmt: TSESTree.Statement): boolean {
  if (stmt.type === AST_NODE_TYPES.ReturnStatement && stmt.argument) {
    return isResponseLikeExpression(stmt.argument);
  }

  if (stmt.type === AST_NODE_TYPES.ExpressionStatement) {
    const expr = stmt.expression;

    if (
      expr.type === AST_NODE_TYPES.AssignmentExpression &&
      expr.left.type === AST_NODE_TYPES.MemberExpression &&
      expr.left.object.type === AST_NODE_TYPES.Identifier &&
      expr.left.object.name === "set" &&
      expr.left.property.type === AST_NODE_TYPES.Identifier &&
      expr.left.property.name === "status"
    ) {
      return true;
    }
  }

  if (stmt.type === AST_NODE_TYPES.IfStatement) {
    if (statementBuildsResponse(stmt.consequent)) {
      return true;
    }

    if (stmt.alternate && statementBuildsResponse(stmt.alternate)) {
      return true;
    }
  }

  if (stmt.type === AST_NODE_TYPES.BlockStatement) {
    for (const inner of stmt.body) {
      if (statementBuildsResponse(inner)) {
        return true;
      }
    }
  }

  return false;
}

function isResponseLikeExpression(node: TSESTree.Expression): boolean {
  if (node.type === AST_NODE_TYPES.NewExpression) {
    return (
      node.callee.type === AST_NODE_TYPES.Identifier &&
      node.callee.name === "Response"
    );
  }

  if (
    node.type === AST_NODE_TYPES.CallExpression &&
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.object.type === AST_NODE_TYPES.Identifier &&
    node.callee.object.name === "Response" &&
    node.callee.property.type === AST_NODE_TYPES.Identifier &&
    node.callee.property.name === "json"
  ) {
    return true;
  }

  if (
    node.type === AST_NODE_TYPES.Literal ||
    node.type === AST_NODE_TYPES.ObjectExpression ||
    node.type === AST_NODE_TYPES.ArrayExpression
  ) {
    return true;
  }

  return false;
}
