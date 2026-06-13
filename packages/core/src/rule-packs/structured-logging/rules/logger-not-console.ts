import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { matchesAnyGlobPattern, toPosixRelative } from "../../utils";

export const RULE_NAME = "logger-not-console";

export interface ILoggerNotConsoleOptions {
  readonly serviceGlobs?: readonly string[];
  readonly consoleMethods?: readonly string[];
}

type RuleOptions = [ILoggerNotConsoleOptions];
type MessageIds = "consoleInService";

const DEFAULT_SERVICE_GLOBS = [
  "**/services/**",
  "**/*.service.ts",
  "**/*.queries.ts",
] as const;

const DEFAULT_CONSOLE_METHODS = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
] as const;

const DEFAULT_SERVICE_PATH_PATTERNS = [
  /(^|\/)services\//,
  /\.service\.tsx?$/,
  /\.queries\.ts$/,
] as const;

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    serviceGlobs: {
      type: "array",
      items: { type: "string" },
    },
    consoleMethods: {
      type: "array",
      items: { type: "string" },
    },
  },
};

function isServiceFile(
  filename: string,
  cwd: string,
  globs: readonly string[]
): boolean {
  const rel = toPosixRelative(filename, cwd);

  if (DEFAULT_SERVICE_PATH_PATTERNS.some((pattern) => pattern.test(rel))) {
    return true;
  }

  return matchesAnyGlobPattern(rel, globs);
}

function isConsoleCall(
  node: TSESTree.CallExpression,
  methods: ReadonlySet<string>
): boolean {
  const callee = node.callee;

  if (callee.type !== AST_NODE_TYPES.MemberExpression || callee.computed) {
    return false;
  }

  if (
    callee.object.type !== AST_NODE_TYPES.Identifier ||
    callee.object.name !== "console"
  ) {
    return false;
  }

  if (callee.property.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }

  return methods.has(callee.property.name);
}

export const loggerNotConsoleRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Service modules should use the structured logger instead of `console.*` — console output is unstructured and hard to search.",
    },
    schema: [optionSchema],
    messages: {
      consoleInService:
        "Use the structured logger instead of `console.{{method}}()` in service modules.",
    },
  },
  defaultOptions: [
    {
      serviceGlobs: [...DEFAULT_SERVICE_GLOBS],
      consoleMethods: [...DEFAULT_CONSOLE_METHODS],
    },
  ],
  create(context, [options]) {
    const serviceGlobs = options.serviceGlobs ?? DEFAULT_SERVICE_GLOBS;
    const consoleMethods = new Set(
      options.consoleMethods ?? DEFAULT_CONSOLE_METHODS
    );
    const cwd = context.cwd;

    if (!isServiceFile(context.filename, cwd, serviceGlobs)) {
      return {};
    }

    return {
      CallExpression(node) {
        if (!isConsoleCall(node, consoleMethods)) {
          return;
        }

        const callee = node.callee;

        if (callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        if (callee.property.type !== AST_NODE_TYPES.Identifier) {
          return;
        }

        context.report({
          node,
          messageId: "consoleInService",
          data: { method: callee.property.name },
        });
      },
    };
  },
});
