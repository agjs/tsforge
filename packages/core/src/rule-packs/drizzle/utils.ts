import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { pushChildNodes, walkAll } from "../utils";

/**
 * Helper utilities for Drizzle rules.
 */

export function isPgTableCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }

  const name = node.callee.name;

  return name === "pgTable" || name === "pgTableCreator";
}

export function isRelationsCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }

  return node.callee.name === "relations";
}

export function isForeignKeyCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }

  return node.callee.name === "foreignKey";
}

export function isSchemaBuilderCall(node: TSESTree.CallExpression): boolean {
  const calleeName = getCalleeIdentifierName(node);

  if (!calleeName) {
    return false;
  }

  // Drizzle schema builders: tables, relations, indices, checks, uniqueConstraints, etc.
  const schemaBuilders = new Set([
    "pgTable",
    "pgTableCreator",
    "relations",
    "index",
    "uniqueIndex",
    "primaryKey",
    "foreignKey",
    "check",
    "unique",
    "schema",
    "serial",
    "smallserial",
    "bigserial",
    "varchar",
    "char",
    "text",
    "integer",
    "smallint",
    "bigint",
    "decimal",
    "numeric",
    "real",
    "doublePrecision",
    "boolean",
    "date",
    "time",
    "timestamp",
    "interval",
    "json",
    "jsonb",
    "uuid",
    "bytea",
    "citext",
    "inet",
    "array",
    "enum",
    "geometry",
    "geography",
  ]);

  return schemaBuilders.has(calleeName);
}

function getCalleeIdentifierName(node: TSESTree.CallExpression): string | null {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return node.callee.name;
  }

  if (
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.property.type === AST_NODE_TYPES.Identifier
  ) {
    return node.callee.property.name;
  }

  return null;
}

export function findCallExpressionsDeep(
  root: TSESTree.Node,
  predicate: (node: TSESTree.CallExpression) => boolean
): TSESTree.CallExpression[] {
  const results: TSESTree.CallExpression[] = [];

  walkAll(root, (node) => {
    if (node.type === AST_NODE_TYPES.CallExpression && predicate(node)) {
      results.push(node);
    }
  });

  return results;
}

function getParent(node: TSESTree.Node): TSESTree.Node | undefined {
  return node.parent;
}

/**
 * Walk up a fluent call chain (`db.update(t).set(x).where(...)`) looking for a
 * `.<methodName>(...)` link whose call satisfies `callMatches`.
 */
export function chainCallProvides(
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

export function chainContainsWhere(
  startCall: TSESTree.CallExpression
): boolean {
  return chainCallProvides(startCall, "where", () => true);
}

export interface IUpdateDeleteQuery {
  readonly kind: "update" | "delete";
  readonly table: string;
}

export function identifyUpdateDeleteQuery(
  node: TSESTree.CallExpression
): IUpdateDeleteQuery | null {
  if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
    return null;
  }

  const property = node.callee.property;

  if (property.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  if (property.name !== "update" && property.name !== "delete") {
    return null;
  }

  const arg = node.arguments[0];

  if (arg?.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  return { kind: property.name, table: arg.name };
}

export function subtreeReferencesIdentifier(
  root: TSESTree.Node,
  name: string
): boolean {
  const stack: TSESTree.Node[] = [root];
  const visited = new WeakSet<TSESTree.Node>();

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (visited.has(node)) {
      continue;
    }

    visited.add(node);

    if (node.type === AST_NODE_TYPES.Identifier && node.name === name) {
      return true;
    }

    if (
      node.type === AST_NODE_TYPES.MemberExpression &&
      node.property.type === AST_NODE_TYPES.Identifier &&
      node.property.name === name
    ) {
      return true;
    }

    pushChildNodes(node, stack);
  }

  return false;
}

export function chainContainsWhereWithScope(
  startCall: TSESTree.CallExpression,
  scopeColumns: readonly string[]
): boolean {
  return chainCallProvides(startCall, "where", (call) => {
    const firstArg = call.arguments[0];

    if (firstArg === undefined) {
      return false;
    }

    return scopeColumns.some((col) =>
      subtreeReferencesIdentifier(firstArg, col)
    );
  });
}
