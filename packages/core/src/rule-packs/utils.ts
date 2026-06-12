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
