import path from "node:path";

/**
 * Returns the file's repo-relative path with forward slashes — glob
 * patterns assume `/` regardless of platform.
 */
export function toPosixRelative(filename: string, cwd: string): string {
  const rel = path.relative(cwd, filename);

  return rel.split(path.sep).join("/");
}

/**
 * Simple glob-like matching for patterns.
 */
export function matchesAnyGlob(
  relativePath: string,
  patterns: readonly string[]
): boolean {
  if (patterns.length === 0) {
    return false;
  }

  return patterns.some((pat) => matchesGlobPattern(relativePath, pat));
}

function matchesGlobPattern(filePath: string, pattern: string): boolean {
  // Convert glob to regex
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

  return regex.test(filePath);
}

/**
 * Returns true when `importSource` matches any of the configured patterns.
 * Patterns may be globs (`**\/db/**`) or bare module specifiers
 * (`drizzle-orm`). Bare specifiers match exact-equal or prefix-with-`/`.
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

    if (importSource === pat || importSource.startsWith(`${pat}/`)) {
      return true;
    }
  }

  return false;
}
