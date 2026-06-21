import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";
import { isScannableSource } from "./is-scannable";

const ESLINT_DISABLE_PATTERN = /\beslint-disable(?:-next-line|-line)?\b/u;

export const noEslintDisableCommentsRule: IMetaRule = {
  id: "no-eslint-disable-comments",
  category: "source-text",
  description:
    "Source files must not contain inline eslint-disable directives.",
  severity: "error",
  // Change-scoped: scan only files the agent touched this turn (changedFiles),
  // never the full tree — so a pre-existing disable in untouched brownfield code
  // doesn't wedge the gate. Self-checks the path (the registry's per-write contract).
  run({ changedFiles, readFile }) {
    const violations: IMetaRuleViolation[] = [];

    for (const file of changedFiles) {
      if (!isScannableSource(file)) {
        continue;
      }

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
