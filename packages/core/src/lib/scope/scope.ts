import { resolve, relative } from "node:path";
import { SCRATCH_PREFIX } from "./scope.constants";

/**
 * Normalize a model-supplied path against the workspace root, fixing the common
 * small-model footguns that otherwise nest files wrongly: an ABSOLUTE path inside
 * the workspace, or a RELATIVE path that redundantly repeats the workspace
 * location (`agjs/code/app/x.ts` while cwd is `/agjs/code/app` → without this it
 * lands at `…/app/agjs/code/app/x.ts`). Returns a path relative to `cwd`; a path
 * that escapes the workspace comes back with `../` and is then rejected by scope.
 */
export function normalizeWorkspacePath(cwd: string, file: string): string {
  const cwdNoSlash = cwd.replace(/^\/+/, "");
  let candidate = file;

  if (candidate.startsWith(`${cwd}/`)) {
    candidate = candidate.slice(cwd.length + 1);
  } else if (candidate.startsWith(`${cwdNoSlash}/`)) {
    candidate = candidate.slice(cwdNoSlash.length + 1);
  }

  return relative(cwd, resolve(cwd, candidate));
}

/** True when `file` matches any of the glob `patterns` (the editable scope). */
export function isInScope(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(file));
}

/** True when `file` matches one of `patterns` — the VENDORED, harness-authored
 *  files the model must not rewrite. `patterns` is supplied per-session
 *  (`IToolContext.vendored`), so it is empty (⇒ always false) outside a web
 *  scaffold. Expects the workspace-relative form (`normalizeWorkspacePath` first). */
export function isVendored(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(file));
}

/** A file the model may write: its editable scope, OR a throwaway scratch file.
 *  A path that escapes the workspace (`../…`) or is absolute is NEVER writable —
 *  a recursive glob would otherwise match a traversal path. Normalize with
 *  `normalizeWorkspacePath` first so this sees the workspace-relative form. */
export function writable(file: string, patterns: string[]): boolean {
  if (file.startsWith("..") || file.startsWith("/")) {
    return false;
  }

  return isInScope(file, patterns) || file.startsWith(SCRATCH_PREFIX);
}
