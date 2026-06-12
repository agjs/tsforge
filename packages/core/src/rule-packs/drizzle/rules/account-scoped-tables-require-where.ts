import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { matchesAnyGlobPattern, pushChildNodes } from "../../utils";

export const RULE_NAME = "account-scoped-tables-require-where";

export interface AccountScopedTablesRequireWhereOptions {
  readonly tables?: readonly string[];
  readonly scopeColumn?: string;
  readonly alternateScopeColumns?: readonly string[];
  readonly allowFiles?: readonly string[];
}

type RuleOptions = [AccountScopedTablesRequireWhereOptions];
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

export const accountScopedTablesRequireWhereRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every Drizzle query against a configured account-scoped table to filter by a scope column (accountId by default).",
    },
    schema: [optionSchema],
    messages: {
      missingScopeFilter:
        "Drizzle query against account-scoped table `{{table}}` is missing a `{{scopeColumn}}` filter. Account-scoped queries must include `{{scopeColumn}}` in their WHERE / values / insert payload — otherwise data from other tenants leaks.",
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
        const queryShape = identifyQuery(node, tables);

        if (!queryShape) {
          return;
        }

        if (
          queryShape.kind === "from" ||
          queryShape.kind === "update" ||
          queryShape.kind === "delete"
        ) {
          if (chainContainsWhereWithAnyScope(node, scopeColumns)) {
            return;
          }
        } else if (queryShape.kind === "insert") {
          if (chainContainsValuesWithScope(node, scopeColumn)) {
            return;
          }
        } else if (
          queryShape.kind === "queryBuilder" &&
          objectArgumentContainsAnyScope(node, scopeColumns)
        ) {
          return;
        }

        context.report({
          node,
          messageId: "missingScopeFilter",
          data: { table: queryShape.table, scopeColumn },
        });
      },
    };
  },
});

function chainContainsWhereWithAnyScope(
  startCall: TSESTree.CallExpression,
  scopeColumns: readonly string[]
): boolean {
  return scopeColumns.some((col) =>
    chainContainsWhereWithScope(startCall, col)
  );
}

function objectArgumentContainsAnyScope(
  node: TSESTree.CallExpression,
  scopeColumns: readonly string[]
): boolean {
  return scopeColumns.some((col) => objectArgumentContainsScope(node, col));
}

interface QueryShape {
  readonly kind: "from" | "insert" | "update" | "delete" | "queryBuilder";
  readonly table: string;
}

function identifyQuery(
  node: TSESTree.CallExpression,
  tables: Set<string>
): QueryShape | null {
  if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
    return null;
  }

  const property = node.callee.property;

  if (property.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  const directKinds = ["from", "insert", "update", "delete"] as const;
  const direct = directKinds.find((kind) => kind === property.name);

  if (direct !== undefined) {
    const arg = node.arguments[0];

    if (arg?.type === AST_NODE_TYPES.Identifier && tables.has(arg.name)) {
      return { kind: direct, table: arg.name };
    }

    return null;
  }

  if (property.name === "findFirst" || property.name === "findMany") {
    const tableName = extractQueryBuilderTable(node);

    if (tableName !== null && tables.has(tableName)) {
      return { kind: "queryBuilder", table: tableName };
    }
  }

  return null;
}

function extractQueryBuilderTable(
  node: TSESTree.CallExpression
): string | null {
  if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
    return null;
  }

  const obj = node.callee.object;

  if (obj.type !== AST_NODE_TYPES.MemberExpression) {
    return null;
  }

  if (obj.property.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  return obj.property.name;
}

function getParent(node: TSESTree.Node): TSESTree.Node | undefined {
  return node.parent;
}

/**
 * Walk up a fluent call chain (`db.update(t).set(x).where(...)`) looking for a
 * `.<methodName>(...)` link whose call satisfies `callMatches`.
 */
function chainCallProvides(
  startCall: TSESTree.CallExpression,
  methodName: string,
  callMatches: (call: TSESTree.CallExpression) => boolean
): boolean {
  let current: TSESTree.Node = startCall;
  let parent = getParent(current);

  while (parent !== undefined) {
    if (
      parent.type === AST_NODE_TYPES.MemberExpression &&
      parent.object === current &&
      parent.property.type === AST_NODE_TYPES.Identifier &&
      parent.property.name === methodName
    ) {
      const call = getParent(parent);

      if (call?.type === AST_NODE_TYPES.CallExpression && callMatches(call)) {
        return true;
      }
    }

    if (
      parent.type === AST_NODE_TYPES.MemberExpression ||
      parent.type === AST_NODE_TYPES.CallExpression
    ) {
      current = parent;
      parent = getParent(current);

      continue;
    }

    break;
  }

  return false;
}

function chainContainsWhereWithScope(
  startCall: TSESTree.CallExpression,
  scopeColumn: string
): boolean {
  return chainCallProvides(startCall, "where", (call) => {
    const firstArg = call.arguments[0];

    return (
      firstArg !== undefined &&
      subtreeReferencesIdentifier(firstArg, scopeColumn)
    );
  });
}

function chainContainsValuesWithScope(
  startCall: TSESTree.CallExpression,
  scopeColumn: string
): boolean {
  return chainCallProvides(startCall, "values", (call) =>
    valuesCallProvidesScope(call, scopeColumn)
  );
}

function valuesCallProvidesScope(
  valuesCall: TSESTree.CallExpression,
  scopeColumn: string
): boolean {
  const firstArg = valuesCall.arguments[0];

  if (firstArg === undefined) {
    return false;
  }

  if (objectExpressionMentionsKey(firstArg, scopeColumn)) {
    return true;
  }

  if (firstArg.type === AST_NODE_TYPES.ArrayExpression) {
    return firstArg.elements.some(
      (element) =>
        element !== null && objectExpressionMentionsKey(element, scopeColumn)
    );
  }

  return false;
}

function objectArgumentContainsScope(
  node: TSESTree.CallExpression,
  scopeColumn: string
): boolean {
  const arg = node.arguments[0];

  if (arg?.type !== AST_NODE_TYPES.ObjectExpression) {
    return false;
  }

  for (const property of arg.properties) {
    if (
      property.type === AST_NODE_TYPES.Property &&
      property.key.type === AST_NODE_TYPES.Identifier &&
      property.key.name === "where" &&
      subtreeReferencesIdentifier(property.value, scopeColumn)
    ) {
      return true;
    }
  }

  return false;
}

function objectExpressionMentionsKey(
  node: TSESTree.Node,
  key: string
): boolean {
  if (node.type !== AST_NODE_TYPES.ObjectExpression) {
    return false;
  }

  for (const property of node.properties) {
    if (
      property.type === AST_NODE_TYPES.Property &&
      property.key.type === AST_NODE_TYPES.Identifier &&
      property.key.name === key
    ) {
      return true;
    }

    if (property.type === AST_NODE_TYPES.SpreadElement) {
      return true;
    }
  }

  return false;
}

function nodeReferencesIdentifier(node: TSESTree.Node, name: string): boolean {
  if (node.type === AST_NODE_TYPES.Identifier && node.name === name) {
    return true;
  }

  return (
    node.type === AST_NODE_TYPES.MemberExpression &&
    node.property.type === AST_NODE_TYPES.Identifier &&
    node.property.name === name
  );
}

function subtreeReferencesIdentifier(
  root: TSESTree.Node,
  name: string
): boolean {
  const stack: TSESTree.Node[] = [root];
  const visited = new WeakSet();

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (visited.has(node)) {
      continue;
    }

    visited.add(node);

    if (nodeReferencesIdentifier(node, name)) {
      return true;
    }

    pushChildNodes(node, stack);
  }

  return false;
}
