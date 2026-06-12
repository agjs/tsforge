import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { matchesAnyGlobPattern } from "../../utils";

export const RULE_NAME = "schema-files-must-not-import-driver";

export interface SchemaFilesMustNotImportDriverOptions {
  readonly filePattern?: string;
  readonly forbiddenSources?: readonly string[];
  readonly forbiddenSourcePatterns?: readonly string[];
}

type RuleOptions = [SchemaFilesMustNotImportDriverOptions];
type MessageIds = "forbiddenDriverImport";

const DEFAULT_FILE_PATTERN = "**/schema/**/*.schema.ts";

const DEFAULT_FORBIDDEN_SOURCES: readonly string[] = [
  "pg",
  "postgres",
  "node-postgres",
  "mysql2",
  "better-sqlite3",
  "@libsql/client",
  "@neondatabase/serverless",
  "@vercel/postgres",
  "@planetscale/database",
];

const DEFAULT_FORBIDDEN_SOURCE_PATTERNS: readonly string[] = [
  "drizzle-orm/node-postgres",
  "drizzle-orm/postgres-js",
  "drizzle-orm/neon-http",
  "drizzle-orm/neon-serverless",
  "drizzle-orm/vercel-postgres",
  "drizzle-orm/aws-data-api/**",
  "drizzle-orm/mysql2",
  "drizzle-orm/planetscale-serverless",
  "drizzle-orm/tidb-serverless",
  "drizzle-orm/better-sqlite3",
  "drizzle-orm/bun-sqlite",
  "drizzle-orm/d1",
  "drizzle-orm/expo-sqlite",
  "drizzle-orm/libsql",
  "drizzle-orm/op-sqlite",
];

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    filePattern: {
      type: "string",
    },
    forbiddenSources: {
      type: "array",
      uniqueItems: true,
      items: { type: "string" },
    },
    forbiddenSourcePatterns: {
      type: "array",
      uniqueItems: true,
      items: { type: "string" },
    },
  },
};

export const schemaFilesMustNotImportDriverRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow imports from database driver packages inside schema files. Schema files must remain driver-agnostic.",
    },
    schema: [optionSchema],
    messages: {
      forbiddenDriverImport:
        "Schema files must not import from driver package '{{source}}' — schema definitions must remain driver-agnostic. Move the connection setup to the consuming application.",
    },
  },
  defaultOptions: [
    {
      filePattern: DEFAULT_FILE_PATTERN,
      forbiddenSources: [...DEFAULT_FORBIDDEN_SOURCES],
      forbiddenSourcePatterns: [...DEFAULT_FORBIDDEN_SOURCE_PATTERNS],
    },
  ],
  create(context, [options]) {
    const filePattern = options.filePattern ?? DEFAULT_FILE_PATTERN;

    if (!matchesAnyGlobPattern(context.filename, [filePattern])) {
      return {};
    }

    const forbiddenSources = new Set(
      options.forbiddenSources ?? DEFAULT_FORBIDDEN_SOURCES
    );
    const forbiddenPatterns =
      options.forbiddenSourcePatterns ?? DEFAULT_FORBIDDEN_SOURCE_PATTERNS;

    return {
      ImportDeclaration(node) {
        const source = node.source.value;

        if (typeof source !== "string") {
          return;
        }

        if (
          forbiddenSources.has(source) ||
          matchesAnyGlobPattern(source, forbiddenPatterns)
        ) {
          context.report({
            node: node.source,
            messageId: "forbiddenDriverImport",
            data: { source },
          });
        }
      },
    };
  },
});
