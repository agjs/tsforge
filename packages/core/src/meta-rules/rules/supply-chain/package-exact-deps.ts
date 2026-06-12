import { parsePackageJsonObject } from "../../parsers/package-json-parser";
import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

const NON_EXACT_DEP_PATTERN = /(^[~^])|([<>=*xX])|(\s)|(\|\|)/u;

/**
 * Check that dependencies and devDependencies use exact versions (no ^, ~, ranges).
 * peerDependencies are allowed to use ranges.
 */
export const packageExactDepsRule: IMetaRule = {
  id: "package-exact-deps",
  category: "supply-chain",
  description:
    "dependencies and devDependencies must use exact versions (no ^ or ~ ranges).",
  severity: "warn",
  run({ packageJson }) {
    const violations: IMetaRuleViolation[] = [];

    if (packageJson === null) {
      return violations;
    }

    const parsed = parsePackageJsonObject(packageJson);

    if (parsed === null) {
      return violations;
    }

    const sections = [
      ["dependencies", parsed.dependencies],
      ["devDependencies", parsed.devDependencies],
    ] as const;

    for (const [section, entries] of sections) {
      if (entries === undefined) {
        continue;
      }

      for (const [name, spec] of Object.entries(entries)) {
        if (!NON_EXACT_DEP_PATTERN.test(spec)) {
          continue;
        }

        violations.push({
          file: "package.json",
          ruleId: "package-exact-deps",
          severity: "warn",
          message: `${section}.${name} is "${spec}" — dependencies and devDependencies must be exact versions; only peerDependencies should use ranges.`,
        });
      }
    }

    return violations;
  },
};
