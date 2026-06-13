import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "exported-functions-require-return-type";

type MessageIds = "missingReturnType";

function isExported(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.ExportNamedDeclaration ||
    node.type === AST_NODE_TYPES.ExportDefaultDeclaration
  );
}

export const exportedFunctionsRequireReturnTypeRule = createRule<
  [],
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Exported functions should declare an explicit return type at module boundaries.",
    },
    schema: [],
    messages: {
      missingReturnType:
        "Exported function `{{name}}` should declare an explicit return type.",
    },
  },
  defaultOptions: [],
  create(context) {
    function checkFunction(
      node: TSESTree.FunctionDeclaration,
      exported: boolean
    ): void {
      if (!exported || node.returnType !== undefined) {
        return;
      }

      const name = node.id?.name ?? "anonymous";

      context.report({
        node,
        messageId: "missingReturnType",
        data: { name },
      });
    }

    return {
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration) {
        const decl = node.declaration;

        if (decl?.type === AST_NODE_TYPES.FunctionDeclaration) {
          checkFunction(decl, true);
        }
      },
      FunctionDeclaration(node: TSESTree.FunctionDeclaration) {
        if (node.parent !== undefined && isExported(node.parent)) {
          return;
        }

        if (
          node.parent?.type === AST_NODE_TYPES.ExportNamedDeclaration ||
          node.parent?.type === AST_NODE_TYPES.ExportDefaultDeclaration
        ) {
          checkFunction(node, true);
        }
      },
    };
  },
});
