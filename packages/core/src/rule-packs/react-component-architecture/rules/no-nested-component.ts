import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { walkAll } from "../../utils";
import {
  isComponentFile,
  isJsxReturningFunction,
  isStoryFile,
  isTestFile,
} from "../utils";

export const RULE_NAME = "no-nested-component";

type MessageIds = "nestedComponent";

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function returnsJsx(
  node:
    | TSESTree.FunctionDeclaration
    | TSESTree.ArrowFunctionExpression
    | TSESTree.FunctionExpression
): boolean {
  if (node.type === AST_NODE_TYPES.ArrowFunctionExpression) {
    return isJsxReturningFunction(node);
  }

  const body = node.body;

  if (body.type !== AST_NODE_TYPES.BlockStatement) {
    return false;
  }

  for (const stmt of body.body) {
    if (stmt.type !== AST_NODE_TYPES.ReturnStatement) {
      continue;
    }

    const arg = stmt.argument;

    if (
      arg &&
      (arg.type === AST_NODE_TYPES.JSXElement ||
        arg.type === AST_NODE_TYPES.JSXFragment)
    ) {
      return true;
    }
  }

  return false;
}

function isNestedComponentDeclaration(node: TSESTree.Node): boolean {
  if (
    node.type === AST_NODE_TYPES.FunctionDeclaration &&
    node.id !== null &&
    isComponentName(node.id.name) &&
    returnsJsx(node)
  ) {
    return true;
  }

  if (node.type === AST_NODE_TYPES.VariableDeclaration) {
    for (const decl of node.declarations) {
      if (decl.id.type !== AST_NODE_TYPES.Identifier) {
        continue;
      }

      if (!isComponentName(decl.id.name) || decl.init === null) {
        continue;
      }

      if (
        (decl.init.type === AST_NODE_TYPES.ArrowFunctionExpression ||
          decl.init.type === AST_NODE_TYPES.FunctionExpression) &&
        returnsJsx(decl.init)
      ) {
        return true;
      }
    }
  }

  return false;
}

export const noNestedComponentRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow declaring React components inside another component body — nested components reset state on every parent render.",
    },
    schema: [],
    messages: {
      nestedComponent:
        "Do not declare a component inside another component — move it to its own file or to module scope.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename;

    if (
      !isComponentFile(filename) ||
      isStoryFile(filename) ||
      isTestFile(filename)
    ) {
      return {};
    }

    function checkOuterComponent(
      node:
        | TSESTree.FunctionDeclaration
        | TSESTree.ArrowFunctionExpression
        | TSESTree.FunctionExpression
    ): void {
      if (!returnsJsx(node)) {
        return;
      }

      const body =
        node.type === AST_NODE_TYPES.ArrowFunctionExpression
          ? node.body.type === AST_NODE_TYPES.BlockStatement
            ? node.body
            : null
          : node.body;

      if (body?.type !== AST_NODE_TYPES.BlockStatement) {
        return;
      }

      walkAll(body, (nested) => {
        if (nested === body) {
          return;
        }

        if (isNestedComponentDeclaration(nested)) {
          context.report({ node: nested, messageId: "nestedComponent" });
        }
      });
    }

    return {
      FunctionDeclaration: checkOuterComponent,
      FunctionExpression: checkOuterComponent,
      ArrowFunctionExpression: checkOuterComponent,
    };
  },
});
