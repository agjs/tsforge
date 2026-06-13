import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-inner-html-assignment";

type MessageIds = "innerHtmlAssignment";

export const noInnerHtmlAssignmentRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow assigning to innerHTML — use textContent/innerText or sanitize with DOMPurify before injecting HTML.",
    },
    schema: [],
    messages: {
      innerHtmlAssignment:
        "Do not assign to `.innerHTML` — use `textContent` for plain text or sanitize HTML with DOMPurify first.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      AssignmentExpression(node: TSESTree.AssignmentExpression) {
        const left = node.left;

        if (
          left.type !== AST_NODE_TYPES.MemberExpression ||
          left.computed ||
          left.property.type !== AST_NODE_TYPES.Identifier ||
          left.property.name !== "innerHTML"
        ) {
          return;
        }

        context.report({ node, messageId: "innerHtmlAssignment" });
      },
    };
  },
});
