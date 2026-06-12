import type { TSESTree } from "@typescript-eslint/utils";
import type { RuleFixer } from "@typescript-eslint/utils/ts-eslint";

import { createRule } from "../../create-rule";
import {
  buildGuardClauseReplacement,
  findWrappedHappyPathIf,
  getFunctionBlockBody,
} from "../utils/prefer-early-return";

export const RULE_NAME = "prefer-early-return";

type MessageIds = "preferEarlyReturn";

export const preferEarlyReturnRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Prefer guard clauses (early return) over wrapping the function body in a multi-statement `if` without an `else`.",
    },
    schema: [],
    messages: {
      preferEarlyReturn:
        "Use a guard clause (early return) instead of wrapping the function body in an `if`. Invert the condition and return early so the happy path stays at the top level.",
    },
    hasSuggestions: true,
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.sourceCode;

    function reportWrappedHappyPath(ifStatement: TSESTree.IfStatement): void {
      const replacement = buildGuardClauseReplacement(sourceCode, ifStatement);
      const suggest =
        replacement === null
          ? []
          : [
              {
                messageId: "preferEarlyReturn" as const,
                fix(fixer: RuleFixer) {
                  return fixer.replaceText(ifStatement, replacement);
                },
              },
            ];

      context.report({
        node: ifStatement,
        messageId: "preferEarlyReturn",
        suggest,
      });
    }

    function checkFunctionBody(
      node:
        | TSESTree.FunctionDeclaration
        | TSESTree.FunctionExpression
        | TSESTree.ArrowFunctionExpression
    ): void {
      const body = getFunctionBlockBody(node);

      if (body === null) {
        return;
      }

      const wrappedIf = findWrappedHappyPathIf(body);

      if (wrappedIf !== null) {
        reportWrappedHappyPath(wrappedIf);
      }
    }

    return {
      FunctionDeclaration: checkFunctionBody,
      FunctionExpression: checkFunctionBody,
      ArrowFunctionExpression: checkFunctionBody,
    };
  },
});
