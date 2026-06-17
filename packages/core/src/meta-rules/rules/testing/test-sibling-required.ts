import { join, dirname, basename } from "node:path";
import { statSync } from "node:fs";
import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";
import { flags } from "../../../config";

/**
 * Patterns that mean "this file exports real logic" — a function or class (incl.
 * exported arrow/function consts). Type-only modules, barrels, and data files
 * don't match, so they're never asked for a test.
 */
const LOGIC_EXPORTS = [
  /\bexport\s+(default\s+)?(async\s+)?function\b/u,
  /\bexport\s+(abstract\s+)?class\b/u,
  /\bexport\s+default\s+class\b/u,
  /\bexport\s+const\s+[A-Za-z_$][\w$]*\s*(?::[^=\n]+)?=\s*(async\s+)?(function\b|\([^)]*\)\s*(?::[^=\n]+)?=>|[A-Za-z_$][\w$]*\s*=>)/u,
];

function isTestPath(file: string): boolean {
  return /\.(test|spec)\.[tj]sx?$/u.test(file);
}

/** A source file that EXPORTS logic and should therefore have a test. Excludes
 *  tests, declaration files, barrels (index), and type-only modules. */
function isLogicFile(file: string, content: string): boolean {
  if (!/\.(ts|tsx)$/u.test(file) || file.endsWith(".d.ts")) {
    return false;
  }

  if (isTestPath(file) || file.endsWith(".types.ts")) {
    return false;
  }

  if (file === "index.ts" || file.endsWith("/index.ts")) {
    return false;
  }

  return LOGIC_EXPORTS.some((re) => re.test(content));
}

function fileExistsAt(root: string, rel: string): boolean {
  try {
    return statSync(join(root, rel)).isFile();
  } catch {
    return false;
  }
}

/** The mirrored test path under `tests/` (src/foo.ts → tests/foo.test.ts), or "". */
function mirroredTest(file: string, ext: string): string {
  const stem = file.slice(0, -ext.length);

  if (file.startsWith("src/")) {
    return `tests/${stem.slice(4)}.test${ext}`;
  }

  if (file.startsWith("scripts/")) {
    return `tests/scripts/${stem.slice(8)}.test${ext}`;
  }

  return "";
}

/** A test exists if there's a co-located `*.test|spec` sibling OR a mirrored
 *  `tests/` file. Supports both layouts — co-located and a parallel tests tree. */
function hasTest(root: string, file: string): boolean {
  const ext = /\.tsx?$/u.exec(file)?.[0] ?? ".ts";
  const stem = file.slice(0, -ext.length);
  const candidates = [
    `${stem}.test${ext}`,
    `${stem}.spec${ext}`,
    mirroredTest(file, ext),
  ];

  return candidates.some((c) => c.length > 0 && fileExistsAt(root, c));
}

export const testSiblingRequiredRule: IMetaRule = {
  id: "test-sibling-required",
  category: "testing",
  description:
    "A logic file (one that exports a function or class) the agent changes must have a test — co-located (*.test.ts) or mirrored under tests/.",
  severity: "warn",
  run({ root, sourceFiles, changedFiles, readFile }) {
    // TDD mode (default ON) makes a missing test a hard gate failure; off → a
    // nudge. Either way, SCOPED to files changed vs HEAD — never a repo's
    // pre-existing untested code. No git signal (empty) → nothing to enforce.
    const severity = flags.tdd() ? "error" : "warn";
    const changed = new Set(changedFiles.map((f) => f.replace(/\\/gu, "/")));

    if (changed.size === 0) {
      return [];
    }

    const violations: IMetaRuleViolation[] = [];

    for (const file of sourceFiles) {
      const norm = file.replace(/\\/gu, "/");

      if (!changed.has(norm)) {
        continue;
      }

      const content = readFile(file);

      if (
        content === null ||
        !isLogicFile(norm, content) ||
        hasTest(root, norm)
      ) {
        continue;
      }

      const stem = basename(norm).replace(/\.tsx?$/u, "");

      violations.push({
        file,
        ruleId: "test-sibling-required",
        severity,
        message: `Missing test for a logic file you changed. Add \`${join(dirname(norm), `${stem}.test.ts`)}\` (co-located) or the mirrored \`tests/\` equivalent — the harness tests what it writes.`,
      });
    }

    return violations;
  },
};
