import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "forwardref-display-name";

type RuleOptions = [];
type MessageIds = "missingDisplayName";

export const forwardrefDisplayNameRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description: "forwardRef components must have displayName set",
    },
    schema: [],
    messages: {
      missingDisplayName:
        'Component using forwardRef must have displayName set: {{name}}.displayName = "..."',
    },
  },
  defaultOptions: [],
  create(context) {
    const forwardRefVars = new Set<string>();

    return {
      "VariableDeclarator > CallExpression"(node: TSESTree.CallExpression) {
        // Check if calling forwardRef or React.forwardRef
        const callee = node.callee;
        let isForwardRef = false;

        if (callee.type === AST_NODE_TYPES.Identifier) {
          isForwardRef = callee.name === "forwardRef";
        } else if (
          callee.type === AST_NODE_TYPES.MemberExpression &&
          callee.object.type === AST_NODE_TYPES.Identifier &&
          callee.object.name === "React" &&
          callee.property.type === AST_NODE_TYPES.Identifier &&
          callee.property.name === "forwardRef"
        ) {
          isForwardRef = true;
        }

        if (
          isForwardRef &&
          node.parent?.type === AST_NODE_TYPES.VariableDeclarator
        ) {
          const decl = node.parent;

          if (decl.id.type === AST_NODE_TYPES.Identifier) {
            forwardRefVars.add(decl.id.name);
          }
        }
      },

      "Program:exit"(program) {
        const displayNameAssignments = new Set<string>();

        // Find all displayName assignments
        for (const stmt of program.body) {
          if (stmt.type === AST_NODE_TYPES.ExpressionStatement) {
            const expr = stmt.expression;

            if (expr.type === AST_NODE_TYPES.AssignmentExpression) {
              const left = expr.left;

              if (
                left.type === AST_NODE_TYPES.MemberExpression &&
                left.object.type === AST_NODE_TYPES.Identifier &&
                left.property.type === AST_NODE_TYPES.Identifier &&
                left.property.name === "displayName"
              ) {
                displayNameAssignments.add(left.object.name);
              }
            }
          }
        }

        // Report missing displayName for forwardRef vars
        for (const varName of forwardRefVars) {
          if (!displayNameAssignments.has(varName)) {
            context.report({
              node: program,
              messageId: "missingDisplayName",
              data: { name: varName },
            });
          }
        }
      },
    };
  },
});
