import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-bare-date-now";

type MessageIds =
  "bareDateNow" | "bareNewDate" | "bareMathRandom" | "bareDateConstructor";

export interface INoBareDateNowOptions {
  readonly allowedPaths?: readonly string[];
}

/**
 * Paths where bare Date/Math.random are expected — the project's clock/rng util.
 * Matched via substring on the normalized filename (see fileMatchesAllowlist).
 * Include bare basenames so root `time.ts` matches (leading `/time.ts` alone
 * misses it). Empty used to be the default, which made EVERY greenfield
 * `src/time.ts` fail and sent models hunting for a non-existent knob.
 */
const DEFAULT_ALLOWED_PATHS: readonly string[] = [
  "/time.ts",
  "/time/",
  "time.ts",
  "/clock.ts",
  "/clock/",
  "clock.ts",
  "/now.ts",
  "now.ts",
  "/random.ts",
  "random.ts",
  "/rng.ts",
  "rng.ts",
];

const DEFAULTS: Required<INoBareDateNowOptions> = {
  allowedPaths: DEFAULT_ALLOWED_PATHS,
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
        "Direct `Date.now()` is non-deterministic. Call the project's `now()` util from a clock file (`time.ts` / `clock.ts` / `now.ts`) instead — do not dig into harness/gate config.",
      bareNewDate:
        "Direct `new Date()` (no args) is non-deterministic. Call the project's `now()` util from a clock file (`time.ts` / `clock.ts` / `now.ts`) instead — do not dig into harness/gate config.",
      bareDateConstructor:
        "Direct `Date()` (no args) is non-deterministic. Call the project's `now()` util from a clock file (`time.ts` / `clock.ts` / `now.ts`) instead — do not dig into harness/gate config.",
      bareMathRandom:
        "Direct `Math.random()` is non-deterministic. Call a project rng util (`random.ts` / `rng.ts` / clock file) instead — do not dig into harness/gate config.",
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
