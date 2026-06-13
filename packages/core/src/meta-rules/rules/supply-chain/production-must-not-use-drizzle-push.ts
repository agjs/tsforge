import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

/** Narrow `unknown` to a record without a type assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const DRIZZLE_PUSH_PATTERN = /\bdrizzle(?:-kit)?\s+push\b/u;

function collectScriptViolations(
  scripts: Record<string, string>
): IMetaRuleViolation[] {
  const violations: IMetaRuleViolation[] = [];

  for (const [name, command] of Object.entries(scripts)) {
    if (!DRIZZLE_PUSH_PATTERN.test(command)) {
      continue;
    }

    violations.push({
      file: "package.json",
      ruleId: "production-must-not-use-drizzle-push",
      severity: "warn",
      message: `Script "${name}" runs \`drizzle-kit push\` — use versioned SQL migrations (drizzle-kit generate + migrate) in production instead of schema push.`,
    });
  }

  return violations;
}

export const productionMustNotUseDrizzlePushRule: IMetaRule = {
  id: "production-must-not-use-drizzle-push",
  category: "supply-chain",
  description:
    "Do not run drizzle-kit push in package.json scripts or CI workflows.",
  severity: "warn",
  appliesTo: ["drizzle"],
  run({ packageJson, workflowFiles, readFile }) {
    const violations: IMetaRuleViolation[] = [];

    if (packageJson !== null) {
      const scriptsValue = packageJson.scripts;

      if (isRecord(scriptsValue)) {
        const scripts: Record<string, string> = {};

        for (const [key, value] of Object.entries(scriptsValue)) {
          if (typeof value === "string") {
            scripts[key] = value;
          }
        }

        violations.push(...collectScriptViolations(scripts));
      }
    }

    for (const file of workflowFiles) {
      const text = readFile(file);

      if (text === null || !DRIZZLE_PUSH_PATTERN.test(text)) {
        continue;
      }

      violations.push({
        file,
        ruleId: "production-must-not-use-drizzle-push",
        severity: "warn",
        message:
          "Workflow runs `drizzle-kit push` — replace with checked-in migrations and `drizzle-kit migrate` for production schema changes.",
      });
    }

    return violations;
  },
};
