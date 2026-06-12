import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  DEFAULT_LOGGER_METHODS,
  DEFAULT_LOGGER_NAMES,
  getStructuredPayload,
  matchLoggerCall,
} from "../utils/logger";

export const RULE_NAME = "require-event-field";

export interface RequireEventFieldOptions {
  readonly loggerNames?: readonly string[];
  readonly loggerMethods?: readonly string[];
  readonly eventField?: string;
}

type RuleOptions = [RequireEventFieldOptions];
type MessageIds = "missingEventField";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    loggerNames: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
    loggerMethods: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
    eventField: { type: "string", minLength: 1 },
  },
};

function payloadHasField(
  payload: TSESTree.ObjectExpression,
  field: string
): boolean {
  for (const prop of payload.properties) {
    if (prop.type === AST_NODE_TYPES.SpreadElement) {
      // Spread of an external object — can't inspect statically.
      // Be permissive: assume the spread might supply the field.
      return true;
    }

    if (prop.type !== AST_NODE_TYPES.Property) {
      continue;
    }

    if (
      prop.key.type === AST_NODE_TYPES.Identifier &&
      prop.key.name === field
    ) {
      return true;
    }

    if (
      prop.key.type === AST_NODE_TYPES.Literal &&
      typeof prop.key.value === "string" &&
      prop.key.value === field
    ) {
      return true;
    }
  }

  return false;
}

export const requireEventFieldRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Require structured logger calls to include an `event` field in their payload, so log searches in ELK/Datadog/Loki don't fall back to substring match.",
    },
    schema: [optionSchema],
    messages: {
      missingEventField:
        "Logger call '{{method}}' missing `{{field}}:` field — add a stable string identifier so searches can filter by event.",
    },
  },
  defaultOptions: [
    {
      loggerNames: [...DEFAULT_LOGGER_NAMES],
      loggerMethods: [...DEFAULT_LOGGER_METHODS],
      eventField: "event",
    },
  ],
  create(context, [options]) {
    const loggerNames = new Set(options.loggerNames ?? DEFAULT_LOGGER_NAMES);
    const loggerMethods = new Set(
      options.loggerMethods ?? DEFAULT_LOGGER_METHODS
    );
    const eventField = options.eventField ?? "event";

    return {
      CallExpression(node) {
        const method = matchLoggerCall(node, loggerNames, loggerMethods);

        if (method === null) {
          return;
        }

        const payload = getStructuredPayload(node);

        if (payload === null) {
          // No structured payload at all — report on the whole call.
          context.report({
            node,
            messageId: "missingEventField",
            data: { method, field: eventField },
          });

          return;
        }

        if (!payloadHasField(payload, eventField)) {
          context.report({
            node: payload,
            messageId: "missingEventField",
            data: { method, field: eventField },
          });
        }
      },
    };
  },
});
