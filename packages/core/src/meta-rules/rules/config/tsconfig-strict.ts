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

/**
 * Check if tsconfig has strict: true or all individual strict flags enabled.
 */
function isStrictEnabled(parsed: unknown): boolean {
  if (!isRecord(parsed)) {
    return false;
  }

  const compilerOptions = parsed.compilerOptions;

  if (!isRecord(compilerOptions)) {
    return false;
  }

  // If strict: true is set, all strict flags are implicitly enabled
  if (compilerOptions.strict === true) {
    return true;
  }

  // Otherwise, check individual strict flags
  const strictFlags = [
    "alwaysStrict",
    "strictBindCallApply",
    "strictFunctionTypes",
    "strictNullChecks",
    "strictPropertyInitialization",
    "noImplicitAny",
    "noImplicitThis",
    "useUnknownInCatchVariables",
  ];

  return strictFlags.every((flag) => {
    const flagValue = compilerOptions[flag];

    return flagValue === true;
  });
}

export const tsconfigStrictRule: IMetaRule = {
  id: "tsconfig-strict",
  category: "config",
  description:
    "tsconfig.json should enable strict mode for type safety (strict: true or all individual strict flags).",
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

      if (!isStrictEnabled(parsed)) {
        violations.push({
          file: "tsconfig.json",
          ruleId: "tsconfig-strict",
          severity: "warn",
          message:
            'tsconfig.json should enable strict mode via "strict": true in compilerOptions for full type safety.',
        });
      }
    } catch {
      // Invalid JSON or file read error — skip this check
    }

    return violations;
  },
};
