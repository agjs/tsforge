import { join } from "node:path";
import { statSync } from "node:fs";
import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

/**
 * File suffixes that indicate logic files requiring tests.
 */
const LOGIC_FILE_SUFFIXES = /\.(service|utils|helpers|handler)\.ts$/u;

/**
 * Directories that are logic-heavy by definition.
 */
const LOGIC_DIRS = new Set(["lib"]);

/**
 * Check if a source file looks like a logic module that should have a test.
 * Excludes test files, type-only modules, and barrel exports.
 */
function isLogicFile(file: string): boolean {
  // Exclude existing test files
  if (file.includes(".test.ts") || file.includes(".spec.ts")) {
    return false;
  }

  // Exclude barrel exports and type-only modules
  if (file.endsWith("/index.ts") || file.endsWith(".types.ts")) {
    return false;
  }

  // Check for logic file suffix
  if (LOGIC_FILE_SUFFIXES.test(file)) {
    return true;
  }

  // Check if in a logic directory
  for (const logicDir of LOGIC_DIRS) {
    if (
      file.includes(`/lib/${logicDir}/`) ||
      file.includes(`\\lib\\${logicDir}\\`)
    ) {
      return true;
    }
  }

  return false;
}

export const testSiblingRequiredRule: IMetaRule = {
  id: "test-sibling-required",
  category: "testing",
  description:
    "Logic modules (*.service.ts, *.utils.ts, etc.) should have a co-located *.test.ts sibling.",
  severity: "warn",
  run({ root, sourceFiles }) {
    const violations: IMetaRuleViolation[] = [];

    for (const file of sourceFiles) {
      if (!isLogicFile(file)) {
        continue;
      }

      // Expected test location: src/foo/bar.ts → tests/foo/bar.test.ts
      const normalized = file.replace(/\\/g, "/");

      let expectedTest: string;

      if (normalized.startsWith("src/")) {
        const relativePath = normalized.slice(4); // Remove "src/"

        expectedTest = join(
          root,
          "tests",
          relativePath.replace(/\.ts$/, ".test.ts")
        );
      } else if (normalized.startsWith("scripts/")) {
        const relativePath = normalized.slice(8); // Remove "scripts/"

        expectedTest = join(
          root,
          "tests",
          "scripts",
          relativePath.replace(/\.ts$/, ".test.ts")
        );
      } else {
        continue; // Unrecognized directory
      }

      try {
        const stat = statSync(expectedTest);

        if (stat.isFile()) {
          continue; // Test exists
        }
      } catch {
        // Test does not exist
      }

      const relativeExpectedTest = expectedTest.slice(root.length + 1);

      violations.push({
        file,
        ruleId: "test-sibling-required",
        severity: "warn",
        message: `Missing unit-test sibling. Expected \`${relativeExpectedTest}\` to exist alongside this logic module.`,
      });
    }

    return violations;
  },
};
