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

/** True when a NORMALIZED path stays inside the workspace — i.e. it neither
 *  escapes via `../` nor is absolute. Distinct from {@link writable}: a project
 *  file the model may not edit is still inside the workspace, and that is exactly
 *  the case a shell redirect must not be allowed to write. */
export function insideWorkspace(file: string): boolean {
  return !file.startsWith("..") && !file.startsWith("/");
}

/** A file the model may write: its editable scope, OR a throwaway scratch file.
 *  A path that escapes the workspace (`../…`) or is absolute is NEVER writable —
 *  a recursive glob would otherwise match a traversal path. Normalize with
 *  `normalizeWorkspacePath` first so this sees the workspace-relative form. */
export function writable(file: string, patterns: string[]): boolean {
  if (file.startsWith("..") || file.startsWith("/")) {
    return false;
  }

  if (isInScope(file, patterns) || file.startsWith(SCRATCH_PREFIX)) {
    return true;
  }

  // The gate's `test-sibling-required` rule makes the model add a CO-LOCATED test
  // for any source file it changes. So a test sibling of an in-scope source must be
  // writable too — otherwise the rule demands a file the scope forbids, the task is
  // unsatisfiable, and the model thrashes to the cycle cap (observed: multi-file
  // specs whose scope lists only sources, e.g. `lexer.ts`, deadlocking on
  // `lexer.test.ts`). Match on the STEM across source extensions, since a `.tsx`
  // source is commonly tested by a plain `.test.ts`. Only an IN-SCOPE source counts.
  const stem = testStem(file);

  return (
    stem !== null &&
    SOURCE_EXTENSIONS.some((ext) => isInScope(`${stem}.${ext}`, patterns))
  );
}

/** Source extensions a co-located test may belong to — checked against the test's
 *  stem so `Component.test.ts` is allowed when `Component.tsx` is in scope. */
const SOURCE_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
];

/** The stem of a `*.test.*` / `*.spec.*` path (everything before `.test`/`.spec`),
 *  or null when `file` isn't a test file. `lexer.test.ts` → `lexer`,
 *  `src/Component.spec.tsx` → `src/Component`. */
function testStem(file: string): string | null {
  // Restrict to REAL test-file extensions (ts/tsx/js/jsx/mts/cts/mjs/cjs) — a loose
  // `[cm]?[jt]sx?` would also match non-existent ones like `.mjsx`/`.mtsx` and widen
  // the writable set. No `*tsx`/`*jsx` with a c/m prefix exists.
  return (
    /^(.*)\.(?:test|spec)\.(?:tsx?|jsx?|[cm]ts|[cm]js)$/u.exec(file)?.[1] ??
    null
  );
}
