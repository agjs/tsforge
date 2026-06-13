import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { walkSome } from "../../utils";

export const RULE_NAME = "require-fp-for-shared-plugins";

type MessageIds = "needsFpWrapper";

function pluginFunctionMutatesFastify(node: TSESTree.Node): boolean {
  return walkSome(node, (current) => {
    if (current.type !== AST_NODE_TYPES.CallExpression) {
      return false;
    }

    const callee = current.callee;

    return (
      callee.type === AST_NODE_TYPES.MemberExpression &&
      !callee.computed &&
      callee.object.type === AST_NODE_TYPES.Identifier &&
      callee.object.name === "fastify" &&
      callee.property.type === AST_NODE_TYPES.Identifier &&
      (callee.property.name === "decorate" ||
        callee.property.name === "addHook" ||
        callee.property.name === "register")
    );
  });
}

function isWrappedInFp(node: TSESTree.Node): boolean {
  let parent = node.parent;

  while (parent) {
    if (
      parent.type === AST_NODE_TYPES.CallExpression &&
      parent.callee.type === AST_NODE_TYPES.Identifier &&
      parent.callee.name === "fp"
    ) {
      return true;
    }

    parent = parent.parent;
  }

  return false;
}

export const requireFpForSharedPluginsRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Fastify plugins that call fastify.decorate, fastify.addHook, or fastify.register must be wrapped in fastify-plugin (fp) to break encapsulation and share state.",
    },
    schema: [],
    messages: {
      needsFpWrapper:
        "Plugin function mutates the Fastify instance — export it wrapped in `fastify-plugin` (`fp(...)`) so decorators and hooks are visible outside the plugin context.",
    },
  },
  defaultOptions: [],
  create(context) {
    function checkPluginFunction(
      node:
        | TSESTree.FunctionDeclaration
        | TSESTree.FunctionExpression
        | TSESTree.ArrowFunctionExpression
    ): void {
      if (!pluginFunctionMutatesFastify(node) || isWrappedInFp(node)) {
        return;
      }

      context.report({ node, messageId: "needsFpWrapper" });
    }

    return {
      ExportDefaultDeclaration(node: TSESTree.ExportDefaultDeclaration) {
        const decl = node.declaration;

        if (
          decl.type === AST_NODE_TYPES.FunctionDeclaration ||
          decl.type === AST_NODE_TYPES.FunctionExpression ||
          decl.type === AST_NODE_TYPES.ArrowFunctionExpression
        ) {
          checkPluginFunction(decl);
        }
      },
      AssignmentExpression(node: TSESTree.AssignmentExpression) {
        if (
          node.left.type === AST_NODE_TYPES.MemberExpression &&
          !node.left.computed &&
          node.left.object.type === AST_NODE_TYPES.Identifier &&
          node.left.object.name === "module" &&
          node.left.property.type === AST_NODE_TYPES.Identifier &&
          node.left.property.name === "exports" &&
          (node.right.type === AST_NODE_TYPES.FunctionExpression ||
            node.right.type === AST_NODE_TYPES.ArrowFunctionExpression)
        ) {
          checkPluginFunction(node.right);
        }
      },
    };
  },
});
