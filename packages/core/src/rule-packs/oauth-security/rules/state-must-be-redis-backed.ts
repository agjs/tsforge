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

export const RULE_NAME = "state-must-be-redis-backed";

export interface StateMustBeRedisBackedOptions {
  readonly stateFiles?: readonly string[];
  readonly redisMethodNames?: readonly string[];
}

type RuleOptions = [StateMustBeRedisBackedOptions];
type MessageIds = "missingRedisWrite" | "stateInCookie";

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
    redisMethodNames: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
  },
};

function isCookieLikeReceiver(name: string): boolean {
  const lower = name.toLowerCase();

  return lower.includes("cookie") || lower.includes("reply") || lower === "res";
}

function extractReceiverIdentifier(obj: TSESTree.Node): string | null {
  let receiver = obj;

  while (receiver.type === AST_NODE_TYPES.MemberExpression) {
    receiver = receiver.object;
  }

  if (receiver.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  return receiver.name;
}

function isCookieSetMethod(name: string): boolean {
  return name === "set" || name === "setCookie";
}

function argumentContainsState(arg: TSESTree.CallExpressionArgument): boolean {
  if (
    arg.type === AST_NODE_TYPES.Identifier &&
    /^(oauth_?)?state$/i.test(arg.name)
  ) {
    return true;
  }

  if (arg.type === AST_NODE_TYPES.ObjectExpression) {
    for (const prop of arg.properties) {
      if (prop.type !== AST_NODE_TYPES.Property || prop.computed) {
        continue;
      }

      if (
        prop.value.type === AST_NODE_TYPES.Identifier &&
        /^(oauth_?)?state$/i.test(prop.value.name)
      ) {
        return true;
      }
    }
  }

  if (
    arg.type === AST_NODE_TYPES.Literal &&
    typeof arg.value === "string" &&
    /^(oauth_?)?state$/i.test(arg.value)
  ) {
    // `setCookie("state", value, ...)` — pattern with the state stuffed
    // into a cookie of that name.
    return true;
  }

  return false;
}

function isCookieSetWithState(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  if (
    callee.type !== AST_NODE_TYPES.MemberExpression ||
    callee.computed ||
    callee.property.type !== AST_NODE_TYPES.Identifier
  ) {
    return false;
  }

  if (!isCookieSetMethod(callee.property.name)) {
    return false;
  }

  const receiver = extractReceiverIdentifier(callee.object);

  if (receiver === null || !isCookieLikeReceiver(receiver)) {
    return false;
  }

  // Look for a `state` or `oauth_state` reference among the args.
  return node.arguments.some((arg) => argumentContainsState(arg));
}

export const stateMustBeRedisBackedRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "OAuth state must be persisted to Redis and not stuffed into a cookie. Cookie-backed state lets attackers replay forged state across sessions.",
    },
    schema: [optionSchema],
    messages: {
      missingRedisWrite:
        "OAuth state file does not call any of `{{methods}}` on a Redis-shaped client — state must be persisted server-side.",
      stateInCookie:
        "Found a cookie write that appears to carry OAuth state — store state in Redis, not in a cookie.",
    },
  },
  defaultOptions: [
    {
      stateFiles: [...DEFAULT_STATE_FILES],
      redisMethodNames: [...DEFAULT_REDIS_METHODS],
    },
  ],
  create(context, [options]) {
    const stateFiles = options.stateFiles ?? DEFAULT_STATE_FILES;
    const redisMethodNames = new Set(
      options.redisMethodNames ?? DEFAULT_REDIS_METHODS
    );

    const relative = ruleRelativePath(context.filename, context.cwd);

    if (!matchesAnyGlobPattern(relative, stateFiles)) {
      return {};
    }

    let redisWriteCount = 0;

    return {
      CallExpression(node) {
        const match = matchRedisCall(node, redisMethodNames);

        if (match !== null) {
          redisWriteCount += 1;

          return;
        }

        if (isCookieSetWithState(node)) {
          context.report({
            node,
            messageId: "stateInCookie",
          });
        }
      },
      "Program:exit"(program) {
        if (redisWriteCount === 0) {
          context.report({
            node: program,
            messageId: "missingRedisWrite",
            data: {
              methods: [...redisMethodNames].join(", "),
            },
          });
        }
      },
    };
  },
});
