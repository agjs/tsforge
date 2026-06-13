import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-unsafe-boundary-cast";

type MessageIds = "unsafeBoundaryCast";

const BOUNDARY_CALLEES = new Set([
  "parse",
  "json",
  "get",
  "getAll",
  "text",
  "formData",
]);

function isBoundarySource(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.CallExpression) {
    const callee = node.callee;

    if (
      callee.type === AST_NODE_TYPES.MemberExpression &&
      !callee.computed &&
      callee.property.type === AST_NODE_TYPES.Identifier &&
      BOUNDARY_CALLEES.has(callee.property.name)
    ) {
      return true;
    }

    if (
      callee.type === AST_NODE_TYPES.MemberExpression &&
      !callee.computed &&
      callee.object.type === AST_NODE_TYPES.Identifier &&
      callee.object.name === "JSON" &&
      callee.property.type === AST_NODE_TYPES.Identifier &&
      callee.property.name === "parse"
    ) {
      return true;
    }
  }

  return false;
}

export const noUnsafeBoundaryCastRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type assertions immediately after parsing untrusted boundary input.",
    },
    schema: [],
    messages: {
      unsafeBoundaryCast:
        "Do not cast untrusted parsed input with `as` — validate with a runtime schema instead.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      TSAsExpression(node: TSESTree.TSAsExpression) {
        if (isBoundarySource(node.expression)) {
          context.report({ node, messageId: "unsafeBoundaryCast" });
        }
      },
    };
  },
});
