import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";
import { detectPresentLockfiles } from "../../utils/lockfiles";

export const singlePackageManagerRule: IMetaRule = {
  id: "single-package-manager",
  category: "supply-chain",
  description:
    "Do not mix lockfiles from different package managers in the same repo.",
  severity: "warn",
  run({ root }) {
    const violations: IMetaRuleViolation[] = [];
    const present = detectPresentLockfiles(root);
    const managers = new Set(present.map((entry) => entry.manager));

    if (managers.size <= 1) {
      return violations;
    }

    const lockfileNames = present.map((entry) => entry.filename).join(", ");

    violations.push({
      file: "package.json",
      ruleId: "single-package-manager",
      severity: "warn",
      message: `Mixed package manager lockfiles detected (${lockfileNames}) — keep one lockfile for a single package manager and delete the rest.`,
    });

    return violations;
  },
};
