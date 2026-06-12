import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { walkAll } from "../utils";

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
