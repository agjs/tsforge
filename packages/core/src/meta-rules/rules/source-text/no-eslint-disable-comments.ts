import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

const ESLINT_DISABLE_PATTERN = /\beslint-disable(?:-next-line|-line)?\b/u;

export const noEslintDisableCommentsRule: IMetaRule = {
  id: "no-eslint-disable-comments",
  category: "source-text",
  description:
    "Source files must not contain inline eslint-disable directives.",
  severity: "error",
  run({ sourceFiles, readFile }) {
    const violations: IMetaRuleViolation[] = [];

    for (const file of sourceFiles) {
      const text = readFile(file);

      if (text === null) {
        continue;
      }

      if (ESLINT_DISABLE_PATTERN.test(text)) {
        violations.push({
          file,
          ruleId: "no-eslint-disable-comments",
          severity: "error",
          message:
            "Inline ESLint disables are not allowed. Fix the rule or add a scoped config override.",
        });
      }
    }

    return violations;
  },
};
