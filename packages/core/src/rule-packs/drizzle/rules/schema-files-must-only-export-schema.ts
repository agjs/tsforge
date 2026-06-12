import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { isSchemaBuilderCall } from "../utils";
import { matchesAnyGlobPattern } from "../../utils";

export const RULE_NAME = "schema-files-must-only-export-schema";

export interface SchemaFilesMustOnlyExportSchemaOptions {
  readonly filePattern?: string;
}

type RuleOptions = [SchemaFilesMustOnlyExportSchemaOptions];
type MessageIds = "nonSchemaExport";

const DEFAULT_FILE_PATTERN = "**/schema/**/*.schema.ts";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    filePattern: {
      type: "string",
    },
  },
};

export const schemaFilesMustOnlyExportSchemaRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Restrict schema files to exporting only Drizzle schema artifacts (tables, schemas, relations, indices) and types.",
    },
    schema: [optionSchema],
    messages: {
      nonSchemaExport:
        "Schema files may only export tables, schemas, relations, and types — move '{{name}}' elsewhere.",
    },
  },
  defaultOptions: [{ filePattern: DEFAULT_FILE_PATTERN }],
  create(context, [options]) {
    const filePattern = options.filePattern ?? DEFAULT_FILE_PATTERN;

    if (!matchesAnyGlobPattern(context.filename, [filePattern])) {
      return {};
    }

    return {
      ExportNamedDeclaration(node) {
        if (node.source) {
          return;
        }

        const declaration = node.declaration;

        if (!declaration) {
          return;
        }

        if (
          declaration.type === AST_NODE_TYPES.TSTypeAliasDeclaration ||
          declaration.type === AST_NODE_TYPES.TSInterfaceDeclaration
        ) {
          return;
        }

        if (declaration.type === AST_NODE_TYPES.VariableDeclaration) {
          for (const declarator of declaration.declarations) {
            if (
              declarator.init?.type === AST_NODE_TYPES.CallExpression &&
              isSchemaBuilderCall(declarator.init)
            ) {
              continue;
            }

            context.report({
              node: declarator,
              messageId: "nonSchemaExport",
              data: { name: getDeclaratorName(declarator) ?? "<anonymous>" },
            });
          }

          return;
        }

        context.report({
          node: declaration,
          messageId: "nonSchemaExport",
          data: { name: getNamedDeclarationName(declaration) ?? "<anonymous>" },
        });
      },
      ExportDefaultDeclaration(node) {
        context.report({
          node,
          messageId: "nonSchemaExport",
          data: { name: getDefaultExportName(node) ?? "default" },
        });
      },
    };
  },
});

function getDeclaratorName(
  declarator: TSESTree.VariableDeclarator
): string | null {
  if (declarator.id.type === AST_NODE_TYPES.Identifier) {
    return declarator.id.name;
  }

  return null;
}

function getNamedDeclarationName(
  declaration: NonNullable<TSESTree.ExportNamedDeclaration["declaration"]>
): string | null {
  if (
    "id" in declaration &&
    declaration.id &&
    declaration.id.type === AST_NODE_TYPES.Identifier
  ) {
    return declaration.id.name;
  }

  return null;
}

function getDefaultExportName(
  node: TSESTree.ExportDefaultDeclaration
): string | null {
  const declaration = node.declaration;

  if (
    "id" in declaration &&
    declaration.id &&
    declaration.id.type === AST_NODE_TYPES.Identifier
  ) {
    return declaration.id.name;
  }

  if (declaration.type === AST_NODE_TYPES.Identifier) {
    return declaration.name;
  }

  return null;
}
