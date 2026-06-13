import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";
import {
  detectPresentLockfiles,
  hasLockfileForManager,
  resolvePackageManager,
} from "../../utils/lockfiles";

const MANAGER_LABELS = {
  npm: "package-lock.json",
  yarn: "yarn.lock",
  pnpm: "pnpm-lock.yaml",
  bun: "bun.lockb or bun.lock",
} as const;

export const lockfileRequiredRule: IMetaRule = {
  id: "lockfile-required",
  category: "supply-chain",
  description:
    "Projects must commit exactly one lockfile matching the detected package manager.",
  severity: "warn",
  run({ root, packageJson }) {
    const violations: IMetaRuleViolation[] = [];
    const manager = resolvePackageManager(root, packageJson);
    const present = detectPresentLockfiles(root);

    if (manager === null) {
      if (present.length === 0) {
        violations.push({
          file: "package.json",
          ruleId: "lockfile-required",
          severity: "warn",
          message:
            "No lockfile found — add the lockfile for your package manager (package-lock.json, yarn.lock, pnpm-lock.yaml, or bun.lockb) and set packageManager in package.json.",
        });
      }

      return violations;
    }

    if (!hasLockfileForManager(root, manager)) {
      violations.push({
        file: "package.json",
        ruleId: "lockfile-required",
        severity: "warn",
        message: `Detected package manager "${manager}" but missing ${MANAGER_LABELS[manager]} — commit the lockfile produced by your package manager.`,
      });
    }

    return violations;
  },
};
