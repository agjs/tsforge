import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { walkSome } from "../../utils";

export const RULE_NAME = "fetch-must-check-ok";

type MessageIds = "missingOkCheck";

function fetchCallHasOkCheck(fetchCall: TSESTree.CallExpression): boolean {
  let parent: TSESTree.Node | null | undefined = fetchCall.parent;

  while (parent !== undefined && parent !== null) {
    if (parent.type === AST_NODE_TYPES.AwaitExpression) {
      parent = parent.parent;
      continue;
    }

    if (parent.type === AST_NODE_TYPES.VariableDeclarator) {
      const init = parent.init;

      if (
        init?.type === AST_NODE_TYPES.AwaitExpression &&
        init.argument === fetchCall
      ) {
        const binding = parent.id;

        if (binding.type === AST_NODE_TYPES.Identifier) {
          const name = binding.name;

          return walkSome(parent.parent ?? fetchCall, (node) => {
            if (
              node.type !== AST_NODE_TYPES.MemberExpression ||
              node.computed
            ) {
              return false;
            }

            return (
              node.object.type === AST_NODE_TYPES.Identifier &&
              node.object.name === name &&
              node.property.type === AST_NODE_TYPES.Identifier &&
              node.property.name === "ok"
            );
          });
        }
      }
    }

    if (
      parent.type === AST_NODE_TYPES.MemberExpression &&
      !parent.computed &&
      parent.property.type === AST_NODE_TYPES.Identifier &&
      parent.property.name === "json"
    ) {
      return false;
    }

    break;
  }

  return true;
}

export const fetchMustCheckOkRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "HTTP fetch responses must check `.ok` or status before calling `.json()`.",
    },
    schema: [],
    messages: {
      missingOkCheck:
        "Check `response.ok` (or status) before calling `.json()` on a fetch response.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;

        if (
          callee.type !== AST_NODE_TYPES.Identifier ||
          callee.name !== "fetch"
        ) {
          return;
        }

        const parent = node.parent;

        if (
          parent?.type === AST_NODE_TYPES.MemberExpression &&
          !parent.computed &&
          parent.property.type === AST_NODE_TYPES.Identifier &&
          parent.property.name === "json" &&
          !fetchCallHasOkCheck(node)
        ) {
          context.report({ node: parent, messageId: "missingOkCheck" });
        }
      },
    };
  },
});
