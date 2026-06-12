import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { matchesAnyGlobPattern, toPosixRelative } from "../../utils";

export const RULE_NAME = "no-direct-process-env";

export interface NoDirectProcessEnvOptions {
  readonly allowedFiles?: readonly string[];
  readonly singletonSuggestion?: string;
}

type RuleOptions = [NoDirectProcessEnvOptions];
type MessageIds = "directProcessEnv";

const DEFAULT_ALLOWED_FILES: readonly string[] = [
  "src/config/env/**",
  "**/*.config.{ts,js,mjs}",
  "scripts/**",
];

const DEFAULT_SUGGESTION = "import { env } from '@/config/env'";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    allowedFiles: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
    singletonSuggestion: { type: "string", minLength: 1 },
  },
};

function isProcessEnv(node: TSESTree.Node): boolean {
  if (node.type !== AST_NODE_TYPES.MemberExpression) {
    return false;
  }

  if (node.computed) {
    return false;
  }

  if (
    node.object.type !== AST_NODE_TYPES.Identifier ||
    node.object.name !== "process"
  ) {
    return false;
  }

  if (
    node.property.type !== AST_NODE_TYPES.Identifier ||
    node.property.name !== "env"
  ) {
    return false;
  }

  return true;
}

export const noDirectProcessEnvRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct `process.env` access — force every consumer through a typed, boot-validated singleton.",
    },
    schema: [optionSchema],
    messages: {
      directProcessEnv:
        "Read environment variables via the validated singleton ({{suggestion}}) — `process.env.X` bypasses the boot-time schema check.",
    },
  },
  defaultOptions: [
    {
      allowedFiles: [...DEFAULT_ALLOWED_FILES],
      singletonSuggestion: DEFAULT_SUGGESTION,
    },
  ],
  create(context, [options]) {
    const allowedFiles = options.allowedFiles ?? DEFAULT_ALLOWED_FILES;
    const suggestion = options.singletonSuggestion ?? DEFAULT_SUGGESTION;

    const relative = toPosixRelative(context.filename, context.cwd);

    if (
      allowedFiles.length > 0 &&
      matchesAnyGlobPattern(relative, [...allowedFiles])
    ) {
      return {};
    }

    function report(node: TSESTree.Node): void {
      context.report({
        node,
        messageId: "directProcessEnv",
        data: { suggestion },
      });
    }

    return {
      // `process.env.X` (read or write) and `process.env[X]`
      MemberExpression(node) {
        if (isProcessEnv(node.object)) {
          report(node);
        }
      },
      // `const { X, Y } = process.env`
      VariableDeclarator(node) {
        if (node.init === null) {
          return;
        }

        if (isProcessEnv(node.init)) {
          report(node.init);
        }
      },
      // `({ X } = process.env)` assignment-pattern destructure
      AssignmentExpression(node) {
        if (
          node.left.type === AST_NODE_TYPES.ObjectPattern &&
          isProcessEnv(node.right)
        ) {
          report(node.right);
        }
      },
    };
  },
});
