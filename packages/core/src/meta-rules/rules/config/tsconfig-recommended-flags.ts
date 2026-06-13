import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

/** Narrow `unknown` to a record without a type assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Strip block and line comments from JSON before parsing. */
function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "")
    .replace(/,\s*([\]}])/gu, "$1");
}

const RECOMMENDED_FLAGS: readonly { flag: string; label: string }[] = [
  { flag: "useUnknownInCatchVariables", label: "useUnknownInCatchVariables" },
  { flag: "erasableSyntaxOnly", label: "erasableSyntaxOnly" },
  { flag: "exactOptionalPropertyTypes", label: "exactOptionalPropertyTypes" },
  { flag: "verbatimModuleSyntax", label: "verbatimModuleSyntax" },
  {
    flag: "noPropertyAccessFromIndexSignature",
    label: "noPropertyAccessFromIndexSignature",
  },
];

export const tsconfigRecommendedFlagsRule: IMetaRule = {
  id: "tsconfig-recommended-flags",
  category: "config",
  description:
    "tsconfig.json should enable recommended strict-adjacent compiler flags (useUnknownInCatchVariables, erasableSyntaxOnly, exactOptionalPropertyTypes, verbatimModuleSyntax, noPropertyAccessFromIndexSignature).",
  severity: "warn",
  run({ root }) {
    const violations: IMetaRuleViolation[] = [];
    const tsconfigPath = join(root, "tsconfig.json");

    try {
      statSync(tsconfigPath);
    } catch {
      return violations;
    }

    try {
      const text = readFileSync(tsconfigPath, "utf8");
      const parsed: unknown = JSON.parse(stripJsonComments(text));

      if (!isRecord(parsed)) {
        return violations;
      }

      const compilerOptions = parsed.compilerOptions;

      if (!isRecord(compilerOptions)) {
        return violations;
      }

      for (const { flag, label } of RECOMMENDED_FLAGS) {
        if (compilerOptions[flag] !== true) {
          violations.push({
            file: "tsconfig.json",
            ruleId: "tsconfig-recommended-flags",
            severity: "warn",
            message: `tsconfig.json compilerOptions should set "${label}": true for stricter, more predictable TypeScript behavior.`,
          });
        }
      }
    } catch {
      // Invalid JSON or file read error — skip this check
    }

    return violations;
  },
};
