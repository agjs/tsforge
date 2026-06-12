import type { TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { isStoryFile } from "../utils";

export const RULE_NAME = "no-inline-jsx-functions";

export interface NoInlineJsxFunctionsOptions {
  readonly allowSpreadPassthrough?: boolean;
}

type RuleOptions = [NoInlineJsxFunctionsOptions];
type MessageIds = "noInlineFunction";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    allowSpreadPassthrough: {
      type: "boolean",
    },
  },
};

export const noInlineJsxFunctionsRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow inline function expressions in JSX attributes",
    },
    schema: [optionSchema],
    messages: {
      noInlineFunction:
        "Use a named function reference instead of an inline function for event handlers",
    },
  },
  defaultOptions: [{ allowSpreadPassthrough: false }],
  create(context) {
    const filename = context.filename;

    if (isStoryFile(filename)) {
      return {};
    }

    return {
      "JSXAttribute > JSXExpressionContainer > ArrowFunctionExpression"(
        node: TSESTree.ArrowFunctionExpression
      ) {
        context.report({
          node,
          messageId: "noInlineFunction",
        });
      },
      "JSXAttribute > JSXExpressionContainer > FunctionExpression"(
        node: TSESTree.FunctionExpression
      ) {
        context.report({
          node,
          messageId: "noInlineFunction",
        });
      },
    };
  },
});
