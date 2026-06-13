import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { walkSome } from "../../utils";

export const RULE_NAME = "catch-must-handle";

type MessageIds = "silentCatch";

function isSilentDefaultReturn(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.ReturnStatement) {
    const arg = node.argument;

    if (arg === null) {
      return true;
    }

    if (arg.type === AST_NODE_TYPES.Identifier && arg.name === "undefined") {
      return true;
    }

    if (arg.type === AST_NODE_TYPES.Literal && arg.value === null) {
      return true;
    }

    if (
      arg.type === AST_NODE_TYPES.ArrayExpression &&
      arg.elements.length === 0
    ) {
      return true;
    }

    if (
      arg.type === AST_NODE_TYPES.ObjectExpression &&
      arg.properties.length === 0
    ) {
      return true;
    }
  }

  return false;
}

function catchBodyHandlesError(body: TSESTree.BlockStatement): boolean {
  if (body.body.length === 0) {
    return false;
  }

  if (
    walkSome(body, (node) => {
      if (node.type === AST_NODE_TYPES.ThrowStatement) {
        return true;
      }

      if (node.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }

      const callee = node.callee;

      if (callee.type === AST_NODE_TYPES.MemberExpression && !callee.computed) {
        const object = callee.object;
        const property = callee.property;

        if (
          object.type === AST_NODE_TYPES.Identifier &&
          object.name === "console" &&
          property.type === AST_NODE_TYPES.Identifier &&
          (property.name === "error" || property.name === "warn")
        ) {
          return true;
        }

        if (
          object.type === AST_NODE_TYPES.Identifier &&
          object.name === "logger" &&
          property.type === AST_NODE_TYPES.Identifier
        ) {
          return true;
        }
      }

      return false;
    })
  ) {
    return true;
  }

  const onlySilentReturns = body.body.every((stmt) => {
    if (stmt.type === AST_NODE_TYPES.ReturnStatement) {
      return isSilentDefaultReturn(stmt);
    }

    return false;
  });

  return !onlySilentReturns;
}

export const catchMustHandleRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Catch blocks must log, rethrow, or propagate errors — not silently return empty defaults on failure.",
    },
    schema: [],
    messages: {
      silentCatch:
        "Catch block silently masks failure — log with `logger.error`/`console.warn`, rethrow, or return a typed error result instead of an empty default.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CatchClause(node: TSESTree.CatchClause) {
        const body = node.body;

        if (!catchBodyHandlesError(body)) {
          context.report({ node, messageId: "silentCatch" });
        }
      },
    };
  },
});
