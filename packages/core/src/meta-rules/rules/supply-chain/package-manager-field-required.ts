import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

export const packageManagerFieldRequiredRule: IMetaRule = {
  id: "package-manager-field-required",
  category: "supply-chain",
  description: "package.json must declare a packageManager field.",
  severity: "warn",
  run({ packageJson }) {
    const violations: IMetaRuleViolation[] = [];

    if (packageJson === null) {
      return violations;
    }

    const value = packageJson.packageManager;

    if (typeof value === "string" && value.trim().length > 0) {
      return violations;
    }

    violations.push({
      file: "package.json",
      ruleId: "package-manager-field-required",
      severity: "warn",
      message:
        'Add a "packageManager" field to package.json (e.g. "bun@1.3.14") so CI and contributors use the same package manager.',
    });

    return violations;
  },
};
