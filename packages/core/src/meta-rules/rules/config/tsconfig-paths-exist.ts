import { join, dirname } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

/** Narrow `unknown` to a record without a type assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const GLOB_CHARS_REGEX = /[*?{}]/u;

/** Strip block and line comments from JSON before parsing. */
function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "")
    .replace(/,\s*([\]}])/gu, "$1");
}

/**
 * Extract literal (non-glob) entries from tsconfig include/files that should
 * point to real files on disk.
 */
function readLiteralEntries(tsconfigPath: string): string[] {
  let parsed: unknown;

  try {
    const text = readFileSync(tsconfigPath, "utf8");

    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }

  const entries: string[] = [];
  const candidates: unknown[] = [];

  if ("include" in parsed) {
    const includeValue = parsed.include;

    if (Array.isArray(includeValue)) {
      candidates.push(includeValue);
    }
  }

  if ("files" in parsed) {
    const filesValue = parsed.files;

    if (Array.isArray(filesValue)) {
      candidates.push(filesValue);
    }
  }

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    for (const item of candidate) {
      if (typeof item !== "string" || GLOB_CHARS_REGEX.test(item)) {
        continue;
      }

      // Skip entries under hidden dirs (.astro/types.d.ts) — build-generated
      const normalized = item.replace(/^\.\//u, "");

      if (normalized.startsWith(".")) {
        continue;
      }

      entries.push(item);
    }
  }

  return entries;
}

export const tsconfigPathsExistRule: IMetaRule = {
  id: "tsconfig-paths-exist",
  category: "config",
  description:
    "Literal tsconfig include/files entries must point to files that exist on disk (glob patterns exempt).",
  severity: "error",
  run({ root }) {
    const violations: IMetaRuleViolation[] = [];
    const tsconfigPath = join(root, "tsconfig.json");

    // Check if tsconfig.json exists
    try {
      statSync(tsconfigPath);
    } catch {
      return violations;
    }

    const entries = readLiteralEntries(tsconfigPath);
    const baseDir = dirname(tsconfigPath);

    for (const entry of entries) {
      const fullPath = join(baseDir, entry);

      if (!existsSync(fullPath)) {
        violations.push({
          file: "tsconfig.json",
          ruleId: "tsconfig-paths-exist",
          severity: "error",
          message: `include/files entry \`${entry}\` does not exist on disk — stale config references misdocument the project shape (globs are exempt).`,
        });
      }
    }

    return violations;
  },
};
