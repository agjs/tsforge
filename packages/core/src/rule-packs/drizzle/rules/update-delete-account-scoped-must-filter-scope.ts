import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { matchesAnyGlobPattern } from "../../utils";
import {
  chainContainsWhereWithScope,
  identifyUpdateDeleteQuery,
} from "../utils";

export const RULE_NAME = "update-delete-account-scoped-must-filter-scope";

export interface IUpdateDeleteAccountScopedMustFilterScopeOptions {
  readonly tables?: readonly string[];
  readonly scopeColumn?: string;
  readonly alternateScopeColumns?: readonly string[];
  readonly allowFiles?: readonly string[];
}

type RuleOptions = [IUpdateDeleteAccountScopedMustFilterScopeOptions];
type MessageIds = "missingScopeFilter";

const DEFAULT_SCOPE_COLUMN = "accountId";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    tables: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
    scopeColumn: { type: "string", minLength: 1 },
    alternateScopeColumns: {
      type: "array",
      items: { type: "string", minLength: 1 },
      uniqueItems: true,
    },
    allowFiles: {
      type: "array",
      items: { type: "string", minLength: 1 },
      uniqueItems: true,
    },
  },
};

export const updateDeleteAccountScopedMustFilterScopeRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Require Drizzle `.update()` / `.delete()` against account-scoped tables to filter by a scope column in `.where()`.",
    },
    schema: [optionSchema],
    messages: {
      missingScopeFilter:
        "Drizzle `.{{kind}}()` on account-scoped table `{{table}}` is missing a `{{scopeColumn}}` filter in `.where()` — tenant data can leak across accounts.",
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const tables = new Set(options.tables ?? []);
    const scopeColumn = options.scopeColumn ?? DEFAULT_SCOPE_COLUMN;
    const alternateScopeColumns = options.alternateScopeColumns ?? [];
    const allowFiles = options.allowFiles ?? [];

    if (tables.size === 0) {
      return {};
    }

    if (matchesAnyGlobPattern(context.filename, allowFiles)) {
      return {};
    }

    const scopeColumns = [scopeColumn, ...alternateScopeColumns];

    return {
      CallExpression(node) {
        const query = identifyUpdateDeleteQuery(node);

        if (query === null || !tables.has(query.table)) {
          return;
        }

        if (chainContainsWhereWithScope(node, scopeColumns)) {
          return;
        }

        context.report({
          node,
          messageId: "missingScopeFilter",
          data: {
            kind: query.kind,
            table: query.table,
            scopeColumn,
          },
        });
      },
    };
  },
});
