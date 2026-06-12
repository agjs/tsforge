import { ESLintUtils } from "@typescript-eslint/utils";

/**
 * RuleCreator for tsforge rules. Generates docs URLs pointing to GitHub.
 */
export const createRule = ESLintUtils.RuleCreator(
  (ruleName) =>
    `https://github.com/tsforge/tsforge/blob/main/docs/rules/${ruleName}.md`
);
