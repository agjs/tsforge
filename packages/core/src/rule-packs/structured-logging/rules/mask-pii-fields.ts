import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  DEFAULT_LOGGER_METHODS,
  DEFAULT_LOGGER_NAMES,
  getStructuredPayload,
  matchLoggerCall,
} from "../utils/logger";

export const RULE_NAME = "mask-pii-fields";

export interface MaskPiiFieldsOptions {
  readonly loggerNames?: readonly string[];
  readonly loggerMethods?: readonly string[];
  readonly piiFieldNames?: readonly string[];
  readonly maskFunctions?: readonly string[];
}

type RuleOptions = [MaskPiiFieldsOptions];
type MessageIds = "unmaskedPii";

const DEFAULT_PII_FIELDS: readonly string[] = [
  "email",
  "phone",
  "password",
  "token",
  "apiKey",
  "secret",
  "ssn",
  "creditCard",
  "authorization",
];

const DEFAULT_MASK_FUNCTIONS: readonly string[] = [
  "maskEmailForLogging",
  "maskToken",
  "maskPii",
  "redact",
  "mask",
];

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
    piiFieldNames: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
    maskFunctions: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
  },
};

function getPropertyKeyName(prop: TSESTree.Property): string | null {
  if (prop.computed) {
    return null;
  }

  if (prop.key.type === AST_NODE_TYPES.Identifier) {
    return prop.key.name;
  }

  if (
    prop.key.type === AST_NODE_TYPES.Literal &&
    typeof prop.key.value === "string"
  ) {
    return prop.key.value;
  }

  return null;
}

const REDACTED_LITERAL = /^(\[?REDACTED\]?|\*+|<masked>|<redacted>)$/i;

const PATTERN_TYPES = new Set<string>([
  AST_NODE_TYPES.AssignmentPattern,
  AST_NODE_TYPES.RestElement,
  AST_NODE_TYPES.ArrayPattern,
  AST_NODE_TYPES.ObjectPattern,
  AST_NODE_TYPES.TSEmptyBodyFunctionExpression,
]);

function isExpression(
  node: TSESTree.Property["value"]
): node is TSESTree.Expression {
  return !PATTERN_TYPES.has(node.type);
}

function isMaskedValue(
  value: TSESTree.Expression,
  maskFunctions: ReadonlySet<string>
): boolean {
  // Already-masked literal: `"[REDACTED]"`, `"***"`, etc.
  if (
    value.type === AST_NODE_TYPES.Literal &&
    typeof value.value === "string" &&
    REDACTED_LITERAL.test(value.value)
  ) {
    return true;
  }

  // Wrapped in a configured mask function: `maskEmailForLogging(email)`,
  // `redact(token)`, `someObj.maskToken(t)`.
  if (value.type !== AST_NODE_TYPES.CallExpression) {
    return false;
  }

  const callee = value.callee;

  if (callee.type === AST_NODE_TYPES.Identifier) {
    return maskFunctions.has(callee.name);
  }

  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier
  ) {
    return maskFunctions.has(callee.property.name);
  }

  return false;
}

export const maskPiiFieldsRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow unmasked PII (email, phone, password, token, ...) in structured-logger payloads — the #1 way data leaks quietly.",
    },
    schema: [optionSchema],
    messages: {
      unmaskedPii:
        "Field '{{field}}' may contain PII — wrap it in {{maskExample}}(...) or use a literal mask before logging.",
    },
  },
  defaultOptions: [
    {
      loggerNames: [...DEFAULT_LOGGER_NAMES],
      loggerMethods: [...DEFAULT_LOGGER_METHODS],
      piiFieldNames: [...DEFAULT_PII_FIELDS],
      maskFunctions: [...DEFAULT_MASK_FUNCTIONS],
    },
  ],
  create(context, [options]) {
    const loggerNames = new Set(options.loggerNames ?? DEFAULT_LOGGER_NAMES);
    const loggerMethods = new Set(
      options.loggerMethods ?? DEFAULT_LOGGER_METHODS
    );
    const piiFieldNames = new Set(options.piiFieldNames ?? DEFAULT_PII_FIELDS);
    const maskFunctions = new Set(
      options.maskFunctions ?? DEFAULT_MASK_FUNCTIONS
    );
    const maskExample =
      options.maskFunctions?.[0] ?? DEFAULT_MASK_FUNCTIONS[0] ?? "mask";

    return {
      CallExpression(node) {
        if (matchLoggerCall(node, loggerNames, loggerMethods) === null) {
          return;
        }

        const payload = getStructuredPayload(node);

        if (payload === null) {
          return;
        }

        for (const prop of payload.properties) {
          if (prop.type !== AST_NODE_TYPES.Property) {
            continue;
          }

          const name = getPropertyKeyName(prop);

          if (name === null || !piiFieldNames.has(name)) {
            continue;
          }

          const value = prop.value;

          if (!isExpression(value)) {
            // Pattern nodes appear only in destructuring contexts; skip.
            continue;
          }

          if (isMaskedValue(value, maskFunctions)) {
            continue;
          }

          context.report({
            node: prop,
            messageId: "unmaskedPii",
            data: { field: name, maskExample },
          });
        }
      },
    };
  },
});
