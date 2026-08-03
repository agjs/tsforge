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
 *  escapes via a `..` path SEGMENT nor is absolute. Distinct from {@link writable}:
 *  a project file the model may not edit is still inside the workspace, and that is
 *  exactly the case a shell redirect must not be allowed to write.
 *
 *  Compares segments, not prefixes: `..secret.ts` is an ordinary filename that
 *  merely starts with two dots. Treating it as outside would skip the guard for a
 *  real workspace file — failing OPEN, the wrong direction for this predicate. */
export function insideWorkspace(file: string): boolean {
  if (file.startsWith("/")) {
    return false;
  }

  // Split on BOTH separators: node:path emits `\` on Windows, and splitting only
  // on `/` would read `..\secret.ts` as one ordinary filename — inside the
  // workspace — and skip the guard there.
  return !file.split(/[\\/]/u).includes("..");
}

/** A file the model may write: its editable scope, OR a throwaway scratch file.
 *  A path that escapes the workspace (`../…`) or is absolute is NEVER writable —
 *  a recursive glob would otherwise match a traversal path. Normalize with
 *  `normalizeWorkspacePath` first so this sees the workspace-relative form.
 *
 *  Escape detection goes through {@link insideWorkspace} so both predicates use the
 *  SAME segment rule. A `startsWith("..")` test here made every ordinary name
 *  beginning with two dots (`..secret.ts`, `...rc`) unwritable through every edit
 *  tool, and — because the shell-redirect guard reads this — let `run` create such
 *  a file even under a scope as broad as `["**\/*"]`. */
export function writable(file: string, patterns: string[]): boolean {
  if (!insideWorkspace(file)) {
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
