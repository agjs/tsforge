import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-bare-date-now";

type MessageIds =
  "bareDateNow" | "bareNewDate" | "bareMathRandom" | "bareDateConstructor";

export interface INoBareDateNowOptions {
  readonly allowedPaths?: readonly string[];
}

const DEFAULTS: Required<INoBareDateNowOptions> = {
  allowedPaths: [],
};

function fileMatchesAllowlist(
  filename: string,
  allowed: readonly string[]
): boolean {
  if (allowed.length === 0) {
    return false;
  }

  const normalized = filename.replace(/\\/g, "/");

  return allowed.some((segment) => normalized.includes(segment));
}

function isDateNow(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  return (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    callee.object.type === AST_NODE_TYPES.Identifier &&
    callee.object.name === "Date" &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    callee.property.name === "now" &&
    !callee.computed
  );
}

function isMathRandom(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  return (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    callee.object.type === AST_NODE_TYPES.Identifier &&
    callee.object.name === "Math" &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    callee.property.name === "random" &&
    !callee.computed
  );
}

function isBareDate(
  node: TSESTree.NewExpression | TSESTree.CallExpression
): boolean {
  return (
    node.callee.type === AST_NODE_TYPES.Identifier &&
    node.callee.name === "Date" &&
    node.arguments.length === 0
  );
}

export const noBareDateNowRule = createRule<
  [INoBareDateNowOptions],
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct calls to non-deterministic time/random sources (`Date.now()`, `new Date()`, `Date()`, `Math.random()`) outside an allowlisted set of utility paths. Determinism is required for snapshot tests, workflow replays, and time-travel debugging — every consumer should route through a typed util that can be faked in tests.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedPaths: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      bareDateNow:
        "Direct `Date.now()` is non-deterministic. Import the project's `now()` util instead (or add the file to this rule's `allowedPaths` if it IS the util).",
      bareNewDate:
        "Direct `new Date()` (no args) is non-deterministic. Import the project's `now()` util and pass the millisecond timestamp explicitly, or add the file to `allowedPaths`.",
      bareDateConstructor:
        "Direct `Date()` (no args) is non-deterministic. Import the project's `now()` util and pass the millisecond timestamp explicitly, or add the file to `allowedPaths`.",
      bareMathRandom:
        "Direct `Math.random()` is non-deterministic. Import the project's random util (which can be seeded in tests) instead, or add the file to `allowedPaths`.",
    },
  },
  defaultOptions: [DEFAULTS],
  create(context, optionsArg) {
    const options = optionsArg[0] ?? DEFAULTS;
    const allowed = options.allowedPaths ?? DEFAULTS.allowedPaths;

    if (fileMatchesAllowlist(context.filename, allowed)) {
      return {};
    }

    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (isDateNow(node)) {
          context.report({ node, messageId: "bareDateNow" });

          return;
        }

        if (isMathRandom(node)) {
          context.report({ node, messageId: "bareMathRandom" });

          return;
        }

        if (isBareDate(node)) {
          context.report({ node, messageId: "bareDateConstructor" });
        }
      },
      NewExpression(node: TSESTree.NewExpression) {
        if (isBareDate(node)) {
          context.report({ node, messageId: "bareNewDate" });
        }
      },
    };
  },
});
