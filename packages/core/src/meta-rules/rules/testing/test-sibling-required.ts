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
  // `[^=]` (not `[^=\n]`) so a multiline type annotation before `=` still matches.
  /\bexport\s+const\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(async\s+)?(function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/u,
];

function isTestPath(file: string): boolean {
  return /\.(test|spec)\.[tj]sx?$/u.test(file);
}

/** A source file that EXPORTS logic and should therefore have a test. Only `.ts`:
 *  presentational `.tsx`/`.jsx` components are exempt (in-loop unit tests for them
 *  are low-value and would make from-scratch web builds impractical — put testable
 *  logic in `.ts`). Also excludes tests, declarations, barrels, and type-only modules. */
function isLogicFile(file: string, content: string): boolean {
  if (!file.endsWith(".ts") || file.endsWith(".d.ts")) {
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

/** The mirrored test path under `tests/` for a given stem + test extension, or "". */
function mirroredTest(file: string, stem: string, testExt: string): string {
  if (file.startsWith("src/")) {
    return `tests/${stem.slice(4)}.test${testExt}`;
  }

  if (file.startsWith("scripts/")) {
    return `tests/scripts/${stem.slice(8)}.test${testExt}`;
  }

  return "";
}

/** A test exists if there's a co-located `*.test|spec` sibling OR a mirrored
 *  `tests/` file. Supports both layouts, and a `.tsx` source whose test is a
 *  plain `.test.ts` (common for components without JSX in the test). */
function hasTest(root: string, file: string): boolean {
  const srcExt = /\.tsx?$/u.exec(file)?.[0] ?? ".ts";
  const stem = file.slice(0, -srcExt.length);
  const testExts = srcExt === ".tsx" ? [".tsx", ".ts"] : [".ts"];
  const candidates: string[] = [];

  for (const e of testExts) {
    candidates.push(
      `${stem}.test${e}`,
      `${stem}.spec${e}`,
      mirroredTest(file, stem, e)
    );
  }

  return candidates.some((c) => c.length > 0 && fileExistsAt(root, c));
}

export const testSiblingRequiredRule: IMetaRule = {
  id: "test-sibling-required",
  category: "testing",
  description:
    "A logic file (one that exports a function or class) the agent changes must have a test — co-located (*.test.ts) or mirrored under tests/.",
  severity: "warn",
  run({ root, changedFiles, readFile }) {
    // TDD mode (default ON) makes a missing test a hard gate failure; off → a
    // nudge. SCOPED to the files the agent changed this session (not the whole
    // tree), so it never blocks on a repo's pre-existing untested code. Iterating
    // changedFiles directly (rather than sourceFiles ∩ changed) means it works
    // regardless of where files live, including a root-level file.
    const severity = flags.tdd() ? "error" : "warn";
    const violations: IMetaRuleViolation[] = [];
    const seen = new Set<string>();

    for (const raw of changedFiles) {
      const norm = raw.replace(/\\/gu, "/");

      if (seen.has(norm)) {
        continue;
      }

      seen.add(norm);
      const content = readFile(norm);

      if (
        content === null ||
        !isLogicFile(norm, content) ||
        hasTest(root, norm)
      ) {
        continue;
      }

      const stem = basename(norm).replace(/\.tsx?$/u, "");

      violations.push({
        file: norm,
        ruleId: "test-sibling-required",
        severity,
        message: `Missing test for a logic file you changed. Add \`${join(dirname(norm), `${stem}.test.ts`).replace(/\\/gu, "/")}\` (co-located) or the mirrored \`tests/\` equivalent — the harness tests what it writes.`,
      });
    }

    return violations;
  },
};
