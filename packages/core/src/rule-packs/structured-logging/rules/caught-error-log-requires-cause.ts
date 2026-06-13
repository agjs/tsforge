import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  DEFAULT_LOGGER_METHODS,
  DEFAULT_LOGGER_NAMES,
  getStructuredPayload,
  matchLoggerCall,
} from "../utils/logger";

export const RULE_NAME = "caught-error-log-requires-cause";

export interface ICaughtErrorLogRequiresCauseOptions {
  readonly loggerNames?: readonly string[];
  readonly loggerMethods?: readonly string[];
  readonly errorIdentifierNames?: readonly string[];
  readonly causeField?: string;
}

type RuleOptions = [ICaughtErrorLogRequiresCauseOptions];
type MessageIds = "missingCause";

const DEFAULT_ERROR_NAMES: readonly string[] = ["error", "err", "e", "cause"];

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
    errorIdentifierNames: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
    causeField: { type: "string", minLength: 1 },
  },
};

function isErrorIdentifier(
  node: TSESTree.Node,
  names: ReadonlySet<string>
): node is TSESTree.Identifier {
  return node.type === AST_NODE_TYPES.Identifier && names.has(node.name);
}

function payloadHasField(
  payload: TSESTree.ObjectExpression,
  field: string
): boolean {
  for (const prop of payload.properties) {
    if (prop.type === AST_NODE_TYPES.SpreadElement) {
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

function loggerCallReferencesCaughtError(
  node: TSESTree.CallExpression,
  catchParam: TSESTree.Identifier | null,
  errorNames: ReadonlySet<string>
): boolean {
  if (catchParam !== null) {
    for (const arg of node.arguments) {
      if (arg.type === AST_NODE_TYPES.SpreadElement) {
        continue;
      }

      if (isErrorIdentifier(arg, new Set([catchParam.name]))) {
        return true;
      }
    }
  }

  const payload = getStructuredPayload(node);

  if (payload === null) {
    return false;
  }

  for (const prop of payload.properties) {
    if (prop.type !== AST_NODE_TYPES.Property) {
      continue;
    }

    if (isErrorIdentifier(prop.value, errorNames)) {
      return true;
    }

    if (
      prop.key.type === AST_NODE_TYPES.Identifier &&
      prop.key.name === "err" &&
      isErrorIdentifier(prop.value, errorNames)
    ) {
      return true;
    }
  }

  return false;
}

export const caughtErrorLogRequiresCauseRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "When logging a caught error, include a `cause` field in the structured payload so downstream tools preserve the error chain.",
    },
    schema: [optionSchema],
    messages: {
      missingCause:
        "Logger call for caught error missing `{{field}}:` — include the original error so cause chains survive structured logging.",
    },
  },
  defaultOptions: [
    {
      loggerNames: [...DEFAULT_LOGGER_NAMES],
      loggerMethods: [...DEFAULT_LOGGER_METHODS],
      errorIdentifierNames: [...DEFAULT_ERROR_NAMES],
      causeField: "cause",
    },
  ],
  create(context, [options]) {
    const loggerNames = new Set(options.loggerNames ?? DEFAULT_LOGGER_NAMES);
    const loggerMethods = new Set(
      options.loggerMethods ?? DEFAULT_LOGGER_METHODS
    );
    const errorNames = new Set(
      options.errorIdentifierNames ?? DEFAULT_ERROR_NAMES
    );
    const causeField = options.causeField ?? "cause";

    return {
      CatchClause(node) {
        const catchParam =
          node.param?.type === AST_NODE_TYPES.Identifier ? node.param : null;
        const body = node.body;

        const visit = (current: TSESTree.Node): void => {
          if (current.type === AST_NODE_TYPES.CallExpression) {
            const method = matchLoggerCall(current, loggerNames, loggerMethods);

            if (
              method !== null &&
              loggerCallReferencesCaughtError(current, catchParam, errorNames)
            ) {
              const payload = getStructuredPayload(current);

              if (payload === null || !payloadHasField(payload, causeField)) {
                context.report({
                  node: current,
                  messageId: "missingCause",
                  data: { field: causeField },
                });
              }
            }
          }

          if (
            current.type === AST_NODE_TYPES.BlockStatement ||
            current.type === AST_NODE_TYPES.Program
          ) {
            for (const stmt of current.body) {
              visit(stmt);
            }
          }

          if (current.type === AST_NODE_TYPES.ExpressionStatement) {
            visit(current.expression);
          }

          if (current.type === AST_NODE_TYPES.IfStatement) {
            visit(current.consequent);

            if (current.alternate !== null) {
              visit(current.alternate);
            }
          }

          if (current.type === AST_NODE_TYPES.TryStatement) {
            visit(current.block);

            if (current.handler !== null) {
              visit(current.handler.body);
            }

            if (current.finalizer !== null) {
              visit(current.finalizer);
            }
          }
        };

        visit(body);
      },
    };
  },
});
