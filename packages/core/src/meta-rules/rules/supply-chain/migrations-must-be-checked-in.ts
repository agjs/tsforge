import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

const MIGRATION_DIRS = ["drizzle", "migrations"] as const;

function directoryHasFiles(root: string, relDir: string): boolean {
  try {
    const stat = statSync(join(root, relDir));

    if (!stat.isDirectory()) {
      return false;
    }

    return readdirSync(join(root, relDir)).length > 0;
  } catch {
    return false;
  }
}

export const migrationsMustBeCheckedInRule: IMetaRule = {
  id: "migrations-must-be-checked-in",
  category: "supply-chain",
  description:
    "When using Drizzle, commit SQL migrations under drizzle/ or migrations/.",
  severity: "warn",
  appliesTo: ["drizzle"],
  run({ root }) {
    const violations: IMetaRuleViolation[] = [];

    const hasMigrationDir = MIGRATION_DIRS.some((dir) =>
      directoryHasFiles(root, dir)
    );

    if (hasMigrationDir) {
      return violations;
    }

    violations.push({
      file: "drizzle/",
      ruleId: "migrations-must-be-checked-in",
      severity: "warn",
      message:
        "No checked-in Drizzle migrations found — add a drizzle/ or migrations/ folder with generated SQL migration files.",
    });

    return violations;
  },
};
