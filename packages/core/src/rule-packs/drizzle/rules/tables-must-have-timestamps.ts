import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { isPgTableCall } from "../utils";

export const RULE_NAME = "tables-must-have-timestamps";

export interface TablesMustHaveTimestampsOptions {
  readonly requireColumns?: readonly string[];
  readonly requireOnUpdate?: readonly string[];
  readonly ignoreTablePattern?: string;
}

type RuleOptions = [TablesMustHaveTimestampsOptions];
type MessageIds = "missingTimestamp" | "missingOnUpdate";

const DEFAULT_REQUIRE_COLUMNS = ["createdAt"] as const;
const DEFAULT_REQUIRE_ON_UPDATE: readonly string[] = [];
const ON_UPDATE_METHODS = new Set(["$onUpdate", "$onUpdateFn"]);

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    requireColumns: {
      type: "array",
      items: {
        type: "string",
      },
      uniqueItems: true,
    },
    requireOnUpdate: {
      type: "array",
      items: {
        type: "string",
      },
      uniqueItems: true,
    },
    ignoreTablePattern: {
      type: "string",
    },
  },
};

export const tablesMustHaveTimestampsRule = createRule<RuleOptions, MessageIds>(
  {
    name: RULE_NAME,
    meta: {
      type: "suggestion",
      docs: {
        description:
          "Require Drizzle tables to declare standard timestamp columns (createdAt by default).",
      },
      schema: [optionSchema],
      messages: {
        missingTimestamp:
          "Table '{{name}}' missing required column(s): {{missing}}.",
        missingOnUpdate:
          "Column '{{column}}' on table '{{name}}' is in `requireOnUpdate` but its `timestamp(...)` chain does not include `.$onUpdate(...)` — without it, the column will not auto-update on row mutations.",
      },
    },
    defaultOptions: [
      {
        requireColumns: [...DEFAULT_REQUIRE_COLUMNS],
        requireOnUpdate: [...DEFAULT_REQUIRE_ON_UPDATE],
      },
    ],
    create(context, [options]) {
      const requireColumns = options.requireColumns ?? DEFAULT_REQUIRE_COLUMNS;
      const requireOnUpdate =
        options.requireOnUpdate ?? DEFAULT_REQUIRE_ON_UPDATE;
      const ignorePattern = compilePattern(options.ignoreTablePattern);

      return {
        VariableDeclarator(node) {
          if (!node.init || node.init.type !== AST_NODE_TYPES.CallExpression) {
            return;
          }

          if (!isPgTableCall(node.init)) {
            return;
          }

          const tableName = getTableName(node);

          if (!tableName) {
            return;
          }

          if (ignorePattern && ignorePattern.test(tableName)) {
            return;
          }

          const columnsArg = node.init.arguments[1];

          const definedColumns =
            columnsArg && columnsArg.type === AST_NODE_TYPES.ObjectExpression
              ? columnsArg
              : null;

          const reportNode =
            node.id.type === AST_NODE_TYPES.Identifier ? node.id : node;

          if (requireColumns.length > 0) {
            const missing = requireColumns.filter(
              (column) => !hasTimestampColumn(definedColumns, column)
            );

            if (missing.length > 0) {
              context.report({
                node: reportNode,
                messageId: "missingTimestamp",
                data: {
                  name: tableName,
                  missing: missing.join(", "),
                },
              });
            }
          }

          if (requireOnUpdate.length > 0 && definedColumns) {
            for (const column of requireOnUpdate) {
              const property = findTimestampProperty(definedColumns, column);

              if (!property) {
                continue;
              }

              if (
                property.value.type === AST_NODE_TYPES.CallExpression &&
                !chainHasOnUpdate(property.value)
              ) {
                context.report({
                  node: property,
                  messageId: "missingOnUpdate",
                  data: {
                    name: tableName,
                    column,
                  },
                });
              }
            }
          }
        },
      };
    },
  }
);

function compilePattern(source: string | undefined): RegExp | null {
  if (!source) {
    return null;
  }

  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

function getTableName(node: TSESTree.VariableDeclarator): string | null {
  if (node.id.type === AST_NODE_TYPES.Identifier) {
    return node.id.name;
  }

  if (node.init?.type === AST_NODE_TYPES.CallExpression) {
    const firstArg = node.init.arguments[0];

    if (
      firstArg &&
      firstArg.type === AST_NODE_TYPES.Literal &&
      typeof firstArg.value === "string"
    ) {
      return firstArg.value;
    }
  }

  return null;
}

function findTimestampProperty(
  columns: TSESTree.ObjectExpression,
  columnName: string
): TSESTree.Property | null {
  for (const property of columns.properties) {
    if (property.type !== AST_NODE_TYPES.Property) {
      continue;
    }

    if (!matchesPropertyKey(property, columnName)) {
      continue;
    }

    if (
      property.value.type === AST_NODE_TYPES.CallExpression &&
      isTimestampInitializer(property.value)
    ) {
      return property;
    }
  }

  return null;
}

function matchesPropertyKey(
  property: TSESTree.Property,
  name: string
): boolean {
  if (
    property.key.type === AST_NODE_TYPES.Identifier &&
    property.key.name === name
  ) {
    return true;
  }

  if (
    property.key.type === AST_NODE_TYPES.Literal &&
    property.key.value === name
  ) {
    return true;
  }

  return false;
}

function isTimestampInitializer(node: TSESTree.CallExpression): boolean {
  const calleeName = getCalleeIdentifierName(node);

  return calleeName === "timestamp";
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

function chainHasOnUpdate(startCall: TSESTree.CallExpression): boolean {
  let current: TSESTree.Node = startCall;
  let parent = getParent(current);

  while (parent !== undefined) {
    if (
      parent.type === AST_NODE_TYPES.MemberExpression &&
      parent.object === current &&
      parent.property.type === AST_NODE_TYPES.Identifier &&
      ON_UPDATE_METHODS.has(parent.property.name)
    ) {
      const methodCall = getParent(parent);

      if (methodCall && methodCall.type === AST_NODE_TYPES.CallExpression) {
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

function getParent(node: TSESTree.Node): TSESTree.Node | undefined {
  return (node as { parent?: TSESTree.Node }).parent;
}

function hasTimestampColumn(
  columns: TSESTree.ObjectExpression | null,
  columnName: string
): boolean {
  if (!columns) {
    return false;
  }

  return findTimestampProperty(columns, columnName) !== null;
}
