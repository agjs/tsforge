import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { walkSome } from "../../utils";
import { calleeName } from "../utils";

export const RULE_NAME = "prefer-lazy-use-state-init";

type MessageIds = "preferLazyInit";

function isExpression(node: TSESTree.Node): node is TSESTree.Expression {
  return node.type !== AST_NODE_TYPES.SpreadElement;
}

function touchesBrowserStorage(node: TSESTree.Node): boolean {
  return walkSome(node, (current) => {
    if (current.type !== AST_NODE_TYPES.MemberExpression || current.computed) {
      return false;
    }

    if (current.object.type !== AST_NODE_TYPES.Identifier) {
      return false;
    }

    return (
      current.object.name === "localStorage" ||
      current.object.name === "sessionStorage"
    );
  });
}

function isLazyInitializer(
  init: TSESTree.Expression | null | undefined
): boolean {
  if (init === null || init === undefined) {
    return false;
  }

  return (
    init.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    init.type === AST_NODE_TYPES.FunctionExpression
  );
}

export const preferLazyUseStateInitRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer lazy useState initializers when parsing localStorage/sessionStorage — avoids re-parsing on every render.",
    },
    schema: [],
    messages: {
      preferLazyInit:
        "Wrap expensive storage parsing in a lazy initializer: `useState(() => JSON.parse(localStorage.getItem('key') ?? '{}'))`.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const name = calleeName(node.callee);

        if (name !== "useState") {
          return;
        }

        const init = node.arguments[0];

        if (init === undefined || !isExpression(init)) {
          return;
        }

        if (isLazyInitializer(init)) {
          return;
        }

        if (touchesBrowserStorage(init)) {
          context.report({ node, messageId: "preferLazyInit" });
        }
      },
    };
  },
});
