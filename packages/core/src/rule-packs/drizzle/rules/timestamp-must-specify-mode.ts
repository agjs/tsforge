import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";

export const RULE_NAME = "timestamp-must-specify-mode";

export interface TimestampMustSpecifyModeOptions {
  readonly allowedModes?: readonly ("date" | "string")[];
}

type RuleOptions = [TimestampMustSpecifyModeOptions];
type MessageIds = "missingMode" | "invalidMode";

const DEFAULT_ALLOWED_MODES = ["date", "string"] as const;

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    allowedModes: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "string",
        enum: ["date", "string"],
      },
      minItems: 1,
    },
  },
};

export const timestampMustSpecifyModeRule = createRule<RuleOptions, MessageIds>(
  {
    name: RULE_NAME,
    meta: {
      type: "problem",
      docs: {
        description:
          "Require every Drizzle timestamp(...) call to explicitly set `mode: 'date'` or `mode: 'string'`.",
      },
      schema: [optionSchema],
      messages: {
        missingMode:
          "timestamp(...) call does not specify `mode` — pass `{ mode: 'date' }` or `{ mode: 'string' }` so return types are deterministic across drivers.",
        invalidMode:
          "timestamp(...) `mode` must be one of: {{allowed}}. Got: {{actual}}.",
      },
    },
    defaultOptions: [{ allowedModes: [...DEFAULT_ALLOWED_MODES] }],
    create(context, [options]) {
      const allowedModes = options.allowedModes ?? DEFAULT_ALLOWED_MODES;

      return {
        CallExpression(node) {
          if (!isTimestampCallee(node)) {
            return;
          }

          const optionsArg = node.arguments[1];

          if (
            !optionsArg ||
            optionsArg.type !== AST_NODE_TYPES.ObjectExpression
          ) {
            context.report({ node, messageId: "missingMode" });

            return;
          }

          const modeProperty = findModeProperty(optionsArg);

          if (!modeProperty) {
            context.report({ node: optionsArg, messageId: "missingMode" });

            return;
          }

          if (
            modeProperty.value.type !== AST_NODE_TYPES.Literal ||
            typeof modeProperty.value.value !== "string"
          ) {
            context.report({
              node: modeProperty,
              messageId: "invalidMode",
              data: {
                allowed: allowedModes.join(" | "),
                actual: "<non-literal>",
              },
            });

            return;
          }

          const modeValue = modeProperty.value.value;

          if (!(allowedModes as readonly string[]).includes(modeValue)) {
            context.report({
              node: modeProperty,
              messageId: "invalidMode",
              data: {
                allowed: allowedModes.join(" | "),
                actual: modeValue,
              },
            });
          }
        },
      };
    },
  }
);

function isTimestampCallee(node: TSESTree.CallExpression): boolean {
  if (
    node.callee.type === AST_NODE_TYPES.Identifier &&
    node.callee.name === "timestamp"
  ) {
    return true;
  }

  if (
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.property.type === AST_NODE_TYPES.Identifier &&
    node.callee.property.name === "timestamp"
  ) {
    return true;
  }

  return false;
}

function findModeProperty(
  obj: TSESTree.ObjectExpression
): TSESTree.Property | null {
  for (const property of obj.properties) {
    if (property.type !== AST_NODE_TYPES.Property) {
      continue;
    }

    if (
      property.key.type === AST_NODE_TYPES.Identifier &&
      property.key.name === "mode"
    ) {
      return property;
    }

    if (
      property.key.type === AST_NODE_TYPES.Literal &&
      property.key.value === "mode"
    ) {
      return property;
    }
  }

  return null;
}
