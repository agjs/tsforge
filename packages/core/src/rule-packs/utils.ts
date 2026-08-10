import path from "node:path";
import type { TSESTree } from "@typescript-eslint/utils";

import { isRecord } from "../lib/guards";

/** Keys on AST nodes that never hold child nodes (or would walk upward). */
export const NON_AST_KEYS = new Set([
  "parent",
  "loc",
  "range",
  "tokens",
  "comments",
  "start",
  "end",
  "leadingComments",
  "trailingComments",
  "innerComments",
]);

/** AST nodes are plain objects with a string `type` discriminant. */
export function isNodeLike(value: unknown): value is TSESTree.Node {
  return isRecord(value) && typeof value.type === "string";
}

/** Push every direct child AST node of `node` onto `stack`. */
export function pushChildNodes(
  node: TSESTree.Node,
  stack: TSESTree.Node[]
): void {
  for (const [key, value] of Object.entries(node)) {
    if (NON_AST_KEYS.has(key)) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const child of value) {
        if (isNodeLike(child)) {
          stack.push(child);
        }
      }
    } else if (isNodeLike(value)) {
      stack.push(value);
    }
  }
}

/** Depth-first visit of `root` and all descendants (cycle-safe). */
export function walkAll(
  root: TSESTree.Node,
  callback: (node: TSESTree.Node) => void
): void {
  const stack: TSESTree.Node[] = [root];
  const visited = new WeakSet();

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (visited.has(node)) {
      continue;
    }

    visited.add(node);
    callback(node);
    pushChildNodes(node, stack);
  }
}

/** True if any node in the subtree satisfies `predicate` (cycle-safe). */
export function walkSome(
  root: TSESTree.Node,
  predicate: (node: TSESTree.Node) => boolean
): boolean {
  const stack: TSESTree.Node[] = [root];
  const visited = new WeakSet();

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (visited.has(node)) {
      continue;
    }

    visited.add(node);

    if (predicate(node)) {
      return true;
    }

    pushChildNodes(node, stack);
  }

  return false;
}

/**
 * Returns the file's repo-relative path with forward slashes for cross-platform consistency.
 */
export function toPosixRelative(filename: string, cwd: string): string {
  const rel = path.relative(cwd, filename);

  return rel.split(path.sep).join("/");
}

/**
 * Repo-relative posix path for allowlist globs. Resolves relative filenames
 * against cwd first so both absolute ESLint paths and test-relative names match.
 */
export function ruleRelativePath(filename: string, cwd: string): string {
  return toPosixRelative(path.resolve(cwd, filename), cwd);
}

/**
 * Glob-like matching for allowlist patterns. Supports double-star directory
 * depth, single-star / question wildcards, brace expansion, and literals.
 */
export function matchesGlobPattern(filePath: string, pattern: string): boolean {
  return expandBraces(pattern).some((expanded) =>
    globToRegExp(expanded).test(filePath)
  );
}

/** Expand one level of `{a,b,c}` braces; recurse until none remain. */
function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf("{");

  if (start < 0) {
    return [pattern];
  }

  const end = pattern.indexOf("}", start);

  if (end < 0) {
    return [pattern];
  }

  const before = pattern.slice(0, start);
  const after = pattern.slice(end + 1);
  const alts = pattern.slice(start + 1, end).split(",");

  return alts.flatMap((alt) => expandBraces(`${before}${alt}${after}`));
}

/** Convert a single brace-free glob to a full-match RegExp. */
function globToRegExp(pattern: string): RegExp {
  let i = 0;
  let out = "^";

  while (i < pattern.length) {
    if (pattern.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
      continue;
    }

    if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
      continue;
    }

    const ch = pattern[i];

    if (ch === undefined) {
      break;
    }

    if (ch === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }

    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }

    out += /[.+^${}()|[\]\\]/u.test(ch) ? `\\${ch}` : ch;

    i += 1;
  }

  return new RegExp(`${out}$`);
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
