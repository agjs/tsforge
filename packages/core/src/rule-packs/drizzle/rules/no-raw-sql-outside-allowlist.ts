import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { matchesAnyGlobPattern } from "../../utils";

export const RULE_NAME = "no-raw-sql-outside-allowlist";

export interface NoRawSqlOutsideAllowlistOptions {
  readonly allowFiles?: readonly string[];
}

type RuleOptions = [NoRawSqlOutsideAllowlistOptions];
type MessageIds = "noRawSql";

const DEFAULT_ALLOW_FILES = [
  "**/migrations/**",
  "**/raw/**",
  "**/health/**",
  "**/*.check.ts",
  "**/tests/**",
  "**/__tests__/**",
] as const;

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    allowFiles: {
      type: "array",
      items: {
        type: "string",
      },
      uniqueItems: true,
    },
  },
};

export const noRawSqlOutsideAllowlistRule = createRule<RuleOptions, MessageIds>(
  {
    name: RULE_NAME,
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow drizzle-orm `sql` tagged template literals outside an allowlist of files (migrations, raw queries).",
      },
      schema: [optionSchema],
      messages: {
        noRawSql:
          "Raw `sql` template literals are not allowed outside the configured allowlist (migrations / raw).",
      },
    },
    defaultOptions: [{ allowFiles: [...DEFAULT_ALLOW_FILES] }],
    create(context, [options]) {
      const allowFiles = options.allowFiles ?? DEFAULT_ALLOW_FILES;

      if (matchesAnyGlobPattern(context.filename, allowFiles)) {
        return {};
      }

      const sqlBindings = new Set<string>();

      return {
        ImportDeclaration(node) {
          if (node.source.value !== "drizzle-orm") {
            return;
          }

          for (const specifier of node.specifiers) {
            if (specifier.type !== AST_NODE_TYPES.ImportSpecifier) {
              continue;
            }

            if (
              specifier.imported.type === AST_NODE_TYPES.Identifier &&
              specifier.imported.name === "sql"
            ) {
              sqlBindings.add(specifier.local.name);
            }
          }
        },
        TaggedTemplateExpression(node) {
          if (node.tag.type !== AST_NODE_TYPES.Identifier) {
            return;
          }

          if (!sqlBindings.has(node.tag.name)) {
            return;
          }

          context.report({
            node,
            messageId: "noRawSql",
          });
        },
      };
    },
  }
);
