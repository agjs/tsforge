import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { matchesAnyGlobPattern, toPosixRelative } from "../../utils";

export const RULE_NAME = "no-process-exit";

export interface NoProcessExitOptions {
  readonly allowedFiles?: readonly string[];
}

type RuleOptions = [NoProcessExitOptions];
type MessageIds = "processExit";

const DEFAULT_ALLOWED_FILES: readonly string[] = [
  // Singleton file AND folder — `error-handlers/**` alone misses error-handlers.ts
  // (same class as env.ts vs env/**).
  "src/config/error-handlers.ts",
  "src/config/error-handlers/**",
  // CLI entrypoints — message promises these; `scripts/**` alone misses src/cli.ts
  // (Reservely dogfood burned turns fighting the gate on a real CLI).
  "src/cli.ts",
  "src/cli/**",
  "bin/**",
  "scripts/**",
  "**/*.test.ts",
  "tests/**",
];

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    allowedFiles: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
  },
};

function isProcessExit(node: TSESTree.CallExpression): boolean {
  if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
    return false;
  }

  if (node.callee.computed) {
    return false;
  }

  if (
    node.callee.object.type !== AST_NODE_TYPES.Identifier ||
    node.callee.object.name !== "process"
  ) {
    return false;
  }

  if (
    node.callee.property.type !== AST_NODE_TYPES.Identifier ||
    node.callee.property.name !== "exit"
  ) {
    return false;
  }

  return true;
}

export const noProcessExitRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `process.exit()` outside the centralized shutdown and CLI entrypoints — forces graceful teardown through the error-handlers module.",
    },
    schema: [optionSchema],
    messages: {
      processExit:
        "`process.exit()` is reserved for graceful shutdown (`src/config/error-handlers/`), CLI entrypoints (`src/cli.ts`, `scripts/`, `bin/`), and tests. Route library shutdown through the centralized handlers instead.",
    },
  },
  defaultOptions: [{ allowedFiles: [...DEFAULT_ALLOWED_FILES] }],
  create(context, [options]) {
    const allowedFiles = options.allowedFiles ?? DEFAULT_ALLOWED_FILES;
    const relative = toPosixRelative(context.filename, context.cwd);

    if (
      allowedFiles.length > 0 &&
      matchesAnyGlobPattern(relative, [...allowedFiles])
    ) {
      return {};
    }

    return {
      CallExpression(node) {
        if (isProcessExit(node)) {
          context.report({ node, messageId: "processExit" });
        }
      },
    };
  },
});
