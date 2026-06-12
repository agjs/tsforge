import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

const TS_SUPPRESS_PATTERN = /@ts-(?:ignore|nocheck|expect-error)/u;

/**
 * TypeScript suppression comments (@ts-ignore, @ts-nocheck, @ts-expect-error)
 * are not allowed without a trailing justification comment.
 */
export const noTsSuppressionRule: IMetaRule = {
  id: "no-ts-suppressions",
  category: "source-text",
  description:
    "TypeScript suppression comments (@ts-ignore, @ts-nocheck, @ts-expect-error) are not allowed.",
  severity: "error",
  run({ sourceFiles, readFile }) {
    const violations: IMetaRuleViolation[] = [];

    for (const file of sourceFiles) {
      const text = readFile(file);

      if (text === null) {
        continue;
      }

      if (TS_SUPPRESS_PATTERN.test(text)) {
        violations.push({
          file,
          ruleId: "no-ts-suppressions",
          severity: "error",
          message:
            "TypeScript suppression comments are not allowed. Narrow the type instead.",
        });
      }
    }

    return violations;
  },
};
