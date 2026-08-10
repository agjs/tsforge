import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  DEFAULT_REDIS_METHODS,
  DEFAULT_STATE_FILES,
  matchesAnyGlobPattern,
  matchRedisCall,
  ruleRelativePath,
} from "../utils";

export const RULE_NAME = "state-ttl-bounded";

export interface StateTtlBoundedOptions {
  readonly stateFiles?: readonly string[];
  readonly maxTtlSeconds?: number;
}

type RuleOptions = [StateTtlBoundedOptions];
type MessageIds = "stateTtlTooLong";

const DEFAULT_MAX_TTL = 600;

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    stateFiles: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
    maxTtlSeconds: { type: "number", minimum: 1 },
  },
};

function getNumericLiteral(node: TSESTree.Node | undefined): number | null {
  if (node?.type === AST_NODE_TYPES.Literal && typeof node.value === "number") {
    return node.value;
  }

  return null;
}

function resolveConstant(
  name: string,
  constants: Map<string, number>
): number | null {
  return constants.get(name) ?? null;
}

export const stateTtlBoundedRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "OAuth state writes to Redis must use a short TTL — long-lived state widens the replay window.",
    },
    schema: [optionSchema],
    messages: {
      stateTtlTooLong:
        "State TTL of {{found}}s exceeds maximum {{max}}s — long-lived state widens the replay window.",
    },
  },
  defaultOptions: [
    {
      stateFiles: [...DEFAULT_STATE_FILES],
      maxTtlSeconds: DEFAULT_MAX_TTL,
    },
  ],
  create(context, [options]) {
    const stateFiles = options.stateFiles ?? DEFAULT_STATE_FILES;
    const maxTtlSeconds = options.maxTtlSeconds ?? DEFAULT_MAX_TTL;
    const redisMethods = new Set(DEFAULT_REDIS_METHODS);

    const relative = ruleRelativePath(context.filename, context.cwd);

    if (!matchesAnyGlobPattern(relative, stateFiles)) {
      return {};
    }

    const constants = new Map<string, number>();

    function checkTtlNode(
      node: TSESTree.CallExpressionArgument,
      reportNode: TSESTree.Node
    ): void {
      let value: number | null = getNumericLiteral(node);

      if (value === null && node.type === AST_NODE_TYPES.Identifier) {
        value = resolveConstant(node.name, constants);

        if (value === null) {
          return;
        }
      }

      if (value === null) {
        return;
      }

      if (value <= maxTtlSeconds) {
        return;
      }

      context.report({
        node: reportNode,
        messageId: "stateTtlTooLong",
        data: { found: String(value), max: String(maxTtlSeconds) },
      });
    }

    function handleSetexCall(node: TSESTree.CallExpression): void {
      const ttl = node.arguments[1];

      if (ttl === undefined) {
        return;
      }

      checkTtlNode(ttl, ttl);
    }

    function handleSetCallWithFlagArg(node: TSESTree.CallExpression): void {
      // ioredis: set(key, value, "EX", ttl) — find "EX" then take next.
      for (let i = 2; i < node.arguments.length - 1; i++) {
        const flag = node.arguments[i];

        if (
          flag?.type === AST_NODE_TYPES.Literal &&
          typeof flag.value === "string" &&
          flag.value.toUpperCase() === "EX"
        ) {
          const ttl = node.arguments[i + 1];

          if (ttl === undefined) {
            return;
          }

          checkTtlNode(ttl, ttl);

          return;
        }
      }
    }

    function handleSetCallWithObjectArg(node: TSESTree.CallExpression): void {
      // node-redis v4: set(key, value, { EX: ttl })
      const last = node.arguments[node.arguments.length - 1];

      if (last?.type !== AST_NODE_TYPES.ObjectExpression) {
        return;
      }

      for (const prop of last.properties) {
        if (prop.type !== AST_NODE_TYPES.Property || prop.computed) {
          continue;
        }

        const keyName =
          prop.key.type === AST_NODE_TYPES.Identifier
            ? prop.key.name
            : prop.key.type === AST_NODE_TYPES.Literal &&
                typeof prop.key.value === "string"
              ? prop.key.value
              : null;

        if (keyName === "EX" || keyName === "PX") {
          if (
            prop.value.type === AST_NODE_TYPES.Literal ||
            prop.value.type === AST_NODE_TYPES.Identifier
          ) {
            checkTtlNode(prop.value, prop.value);
          }

          return;
        }
      }
    }

    return {
      VariableDeclarator(node) {
        if (
          node.id.type === AST_NODE_TYPES.Identifier &&
          node.init !== null &&
          node.init.type === AST_NODE_TYPES.Literal &&
          typeof node.init.value === "number"
        ) {
          constants.set(node.id.name, node.init.value);
        }
      },
      CallExpression(node) {
        const match = matchRedisCall(node, redisMethods);

        if (match === null) {
          return;
        }

        const method = match.method;

        if (method === "setex" || method === "setEx" || method === "SETEX") {
          handleSetexCall(node);

          return;
        }

        if (method === "set" || method === "SET") {
          handleSetCallWithFlagArg(node);

          if (node.arguments.length > 0) {
            handleSetCallWithObjectArg(node);
          }
        }
      },
    };
  },
});
