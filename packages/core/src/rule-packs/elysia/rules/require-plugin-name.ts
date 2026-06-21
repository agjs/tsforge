import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  findObjectProperty,
  getChainRoot,
  isNewElysiaExpression,
} from "../utils/elysiaChain";

export const RULE_NAME = "require-elysia-plugin-name";

export interface RequirePluginNameOptions {
  readonly allowAnonymousDefault?: boolean;
}

type RuleOptions = [RequirePluginNameOptions];
type MessageIds = "missingPluginName";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    allowAnonymousDefault: { type: "boolean" },
  },
};

export const requirePluginNameRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Exported Elysia plugin instances must declare `new Elysia({ name: '...' })` so the runtime can deduplicate plugin re-imports.",
    },
    schema: [optionSchema],
    messages: {
      missingPluginName:
        'Exported Elysia plugin is anonymous — pass `{ name: "..." }` to `new Elysia(...)` so the runtime can deduplicate this plugin across imports.',
    },
  },
  defaultOptions: [{ allowAnonymousDefault: false }],
  create(context, [options]) {
    const allowAnonymousDefault = options.allowAnonymousDefault === true;

    return {
      ExportNamedDeclaration(node) {
        if (node.declaration?.type !== AST_NODE_TYPES.VariableDeclaration) {
          return;
        }

        for (const declarator of node.declaration.declarations) {
          if (declarator.init) {
            checkExpression(declarator.init);
          }
        }
      },
      ExportDefaultDeclaration(node) {
        if (allowAnonymousDefault) {
          return;
        }

        const expr = node.declaration;

        if (
          expr.type === AST_NODE_TYPES.NewExpression ||
          expr.type === AST_NODE_TYPES.CallExpression ||
          expr.type === AST_NODE_TYPES.MemberExpression
        ) {
          checkExpression(expr);
        }
      },
    };

    function checkExpression(expression: TSESTree.Expression): void {
      let root: TSESTree.Node = expression;

      if (
        expression.type === AST_NODE_TYPES.CallExpression ||
        expression.type === AST_NODE_TYPES.MemberExpression
      ) {
        root = getChainRoot(expression);
      }

      if (!isNewElysiaExpression(root)) {
        return;
      }

      const newExpr = root;
      const arg = newExpr.arguments[0];

      if (arg?.type === AST_NODE_TYPES.ObjectExpression) {
        const nameProperty = findObjectProperty(arg, "name");

        if (
          nameProperty?.value.type === AST_NODE_TYPES.Literal &&
          typeof nameProperty.value.value === "string" &&
          nameProperty.value.value.length > 0
        ) {
          return;
        }
      }

      context.report({ node: newExpr, messageId: "missingPluginName" });
    }
  },
});
