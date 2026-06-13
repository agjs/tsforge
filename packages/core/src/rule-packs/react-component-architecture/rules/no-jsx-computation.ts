import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { isStoryFile } from "../utils";

export const RULE_NAME = "no-jsx-computation";

export interface INoJsxComputationOptions {
  readonly allowSimpleTernary?: boolean;
}

type RuleOptions = [INoJsxComputationOptions];
type MessageIds = "noComputation" | "noChainedLogic";

const ARRAY_METHODS = ["map", "filter", "reduce", "sort", "find"];
const ARITHMETIC_OPERATORS = ["+", "-", "*", "/"];

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    allowSimpleTernary: {
      type: "boolean",
    },
  },
};

export const noJsxComputationRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Move complex computations out of JSX into hooks or helper functions",
    },
    schema: [optionSchema],
    messages: {
      noComputation: "Extract this computation into a hook or helper function",
      noChainedLogic:
        "Complex logical expressions should be extracted into variables or hooks",
    },
  },
  defaultOptions: [{ allowSimpleTernary: true }],
  create(context, [options]) {
    const filename = context.filename;

    if (isStoryFile(filename)) {
      return {};
    }

    const allowSimpleTernary = options.allowSimpleTernary ?? true;

    return {
      "JSXExpressionContainer > CallExpression"(node: TSESTree.CallExpression) {
        if (node.callee.type === AST_NODE_TYPES.MemberExpression) {
          const prop = node.callee.property;

          if (
            prop.type === AST_NODE_TYPES.Identifier &&
            ARRAY_METHODS.includes(prop.name)
          ) {
            context.report({
              node,
              messageId: "noComputation",
            });
          }
        }
      },
      "JSXExpressionContainer > ConditionalExpression"(
        node: TSESTree.ConditionalExpression
      ) {
        if (!allowSimpleTernary) {
          context.report({
            node,
            messageId: "noComputation",
          });
        }
      },
      "JSXExpressionContainer > LogicalExpression"(
        node: TSESTree.LogicalExpression
      ) {
        let depth = 0;
        let current: TSESTree.Node = node;

        while (current.type === AST_NODE_TYPES.LogicalExpression) {
          depth += 1;
          current = current.left;
        }

        if (depth > 1) {
          context.report({
            node,
            messageId: "noChainedLogic",
          });
        }
      },
      "JSXExpressionContainer > BinaryExpression"(
        node: TSESTree.BinaryExpression
      ) {
        if (ARITHMETIC_OPERATORS.includes(node.operator)) {
          context.report({
            node,
            messageId: "noComputation",
          });
        }
      },
    };
  },
});
