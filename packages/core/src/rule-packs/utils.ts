import path from "node:path";

/**
 * Returns the file's repo-relative path with forward slashes for cross-platform consistency.
 */
export function toPosixRelative(filename: string, cwd: string): string {
  const rel = path.relative(cwd, filename);

  return rel.split(path.sep).join("/");
}

/**
 * Simple glob-like matching for patterns. Supports:
 * - `**` (match any directory levels)
 * - `*` (match any characters except `/`)
 * - `?` (match single character)
 * - literal strings
 */
export function matchesGlobPattern(path: string, pattern: string): boolean {
  // Escape regex special chars except * and ?
  const regexPattern = pattern
    .split("**/")
    .join("<<<GLOBSTAR>>>")
    .split("/")
    .map((seg) => {
      if (seg === "<<<GLOBSTAR>>>") {
        return ".*";
      }

      return seg
        .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex chars
        .replace(/\*/g, "[^/]*") // * matches anything except /
        .replace(/\?/g, "[^/]"); // ? matches single char except /
    })
    .join("/");

  const regex = new RegExp(`^${regexPattern}$`);

  return regex.test(path);
}

/**
 * Returns true if the path matches any of the glob patterns.
 */
export function matchesAnyGlobPattern(
  filePath: string,
  patterns: readonly string[]
): boolean {
  if (patterns.length === 0) {
    return false;
  }

  return patterns.some((pattern) => matchesGlobPattern(filePath, pattern));
}

/**
 * Simple import-source matcher. Supports:
 * - glob patterns with `*` and `?`
 * - bare module specifiers (exact match or prefix match with `/`)
 */
export function importMatchesAny(
  importSource: string,
  patterns: readonly string[]
): boolean {
  for (const pat of patterns) {
    if (pat.includes("*") || pat.includes("?")) {
      if (matchesGlobPattern(importSource, pat)) {
        return true;
      }

      continue;
    }

    // Bare specifier: exact match or prefix match
    if (importSource === pat || importSource.startsWith(`${pat}/`)) {
      return true;
    }
  }

  return false;
}
