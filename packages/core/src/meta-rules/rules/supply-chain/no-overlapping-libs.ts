import { parsePackageJsonObject } from "../../parsers/package-json-parser";
import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

/**
 * Library pairs that should not coexist in the same project.
 * Each pair is [lib1, lib2] (order-insensitive).
 */
const FORBID_DEP_PAIRS: readonly (readonly [string, string])[] = [
  // Overlapping HTTP clients
  ["axios", "node-fetch"],
  // Overlapping toast/notification libraries
  ["react-hot-toast", "sonner"],
  // Overlapping date libraries
  ["dayjs", "date-fns"],
  ["moment", "dayjs"],
  // Overlapping utility libraries
  ["lodash", "ramda"],
];

export const noOverlappingLibsRule: IMetaRule = {
  id: "no-overlapping-libs",
  category: "supply-chain",
  description:
    "package.json must not list forbidden overlapping library pairs (e.g. axios + node-fetch).",
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

    const merged: Record<string, string> = {
      ...(parsed.dependencies ?? {}),
      ...(parsed.devDependencies ?? {}),
    };

    for (const [firstLib, secondLib] of FORBID_DEP_PAIRS) {
      if (merged[firstLib] !== undefined && merged[secondLib] !== undefined) {
        violations.push({
          file: "package.json",
          ruleId: "no-overlapping-libs",
          severity: "warn",
          message: `Both "${firstLib}" and "${secondLib}" are listed — pick one (forbidden overlapping library stacks).`,
        });
      }
    }

    return violations;
  },
};
