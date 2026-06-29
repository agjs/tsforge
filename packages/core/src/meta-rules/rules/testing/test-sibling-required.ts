import { join, dirname, basename } from "node:path";
import { statSync, readdirSync } from "node:fs";
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
 *  logic in `.ts`). `*.hooks.ts` is also exempt: React hooks (useState/useEffect/
 *  useFrame) need a DOM/fiber render environment to test, so the rule only forced
 *  placeholder tests — put pure, testable logic in `.logic.ts`/`.ts`. Also excludes
 *  tests, declarations, barrels, and type-only modules. */
function isLogicFile(file: string, content: string): boolean {
  if (!file.endsWith(".ts") || file.endsWith(".d.ts")) {
    return false;
  }

  if (
    isTestPath(file) ||
    file.endsWith(".types.ts") ||
    file.endsWith(".hooks.ts")
  ) {
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

/** Static module specifiers a file imports / re-exports from (handles `import x
 *  from`, `import type … from`, side-effect `import "x"`, and `export … from`).
 *  `[^'"]` spans newlines, so multi-line import lists are covered. */
function importSpecifiers(content: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/gu;
  let m: RegExpExecArray | null;

  while ((m = re.exec(content)) !== null) {
    const spec = m[1] ?? m[2];

    if (spec !== undefined) {
      specs.push(spec);
    }
  }

  return specs;
}

/** Resolve an import specifier (seen in `fromFile`) to a repo-relative module
 *  path WITHOUT extension, or null for bare/package imports. Handles `./`, `../`,
 *  and the `@/` → `src/` alias the web scaffold uses. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let rel: string;

  if (spec.startsWith("@/")) {
    rel = `src/${spec.slice(2)}`;
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    rel = join(dirname(fromFile), spec);
  } else {
    return null; // bare/package import — not a local logic file
  }

  return rel.replace(/\\/gu, "/").replace(/\.[tj]sx?$/u, "");
}

/** Repo-relative test-file paths to check for coverage of `file`: the harness's
 *  `sourceFiles` (src/tests/scripts layouts) UNION the logic file's OWN directory
 *  (catches the flat/root layout — e.g. a "generic stack, no package.json" eval
 *  run dir — that `sourceFiles` doesn't scan). */
function candidateTestFiles(
  root: string,
  file: string,
  sourceFiles: readonly string[]
): string[] {
  const out = new Set<string>();

  for (const sf of sourceFiles) {
    const norm = sf.replace(/\\/gu, "/");

    if (isTestPath(norm) && norm !== file) {
      out.add(norm);
    }
  }

  const dir = dirname(file);

  try {
    for (const entry of readdirSync(join(root, dir))) {
      const rel = (dir === "." ? entry : `${dir}/${entry}`).replace(
        /\\/gu,
        "/"
      );

      if (isTestPath(rel) && rel !== file) {
        out.add(rel);
      }
    }
  } catch {
    // dir unreadable — sourceFiles alone
  }

  return [...out];
}

/** Source extensions tried when resolving an extension-less local import to a
 *  readable module file (and its `index.*` barrel form). */
const MODULE_EXTS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** Read the source of a resolved (extension-less) local module, trying the usual
 *  source extensions and an `index.*` barrel. Returns its text, or null. */
function readModuleSource(
  resolved: string,
  readFile: (relPath: string) => string | null
): string | null {
  for (const ext of MODULE_EXTS) {
    const direct = readFile(`${resolved}${ext}`);

    if (direct !== null) {
      return direct;
    }
  }

  for (const ext of MODULE_EXTS) {
    const barrel = readFile(`${resolved}/index${ext}`);

    if (barrel !== null) {
      return barrel;
    }
  }

  return null;
}

/** One hop: does the local module at `resolved` (extension-less) import `target`
 *  directly? Used to credit a facade that re-exports/uses the target. The facade's
 *  own path is the resolution base so its relative imports resolve correctly. */
function facadeImportsTarget(
  resolved: string,
  target: string,
  readFile: (relPath: string) => string | null
): boolean {
  const facade = readModuleSource(resolved, readFile);

  if (facade === null) {
    return false;
  }

  return importSpecifiers(facade).some(
    (inner) => resolveSpecifier(`${resolved}.ts`, inner) === target
  );
}

/** A logic file is already COVERED if some EXISTING test file exercises it —
 *  directly (the test imports it) OR through ONE hop (the test imports a local
 *  facade module that imports it). Without the facade hop the rule is unsatisfiable
 *  for the common layered-spec shape where one integration test drives several
 *  internal modules via a facade — e.g. `query.test.ts` imports only `query.ts`,
 *  which imports `lexer/parser/executor`; demanding a co-located `lexer.test.ts`
 *  deadlocks the model (observed: query failing 2/3 on its turn cap). Bounded to a
 *  SINGLE hop (no recursion) to stay cheap and not over-credit deep chains. */
function coveredByExistingTest(
  root: string,
  file: string,
  sourceFiles: readonly string[],
  readFile: (relPath: string) => string | null
): boolean {
  const target = file.replace(/\\/gu, "/").replace(/\.[tj]sx?$/u, "");

  for (const testFile of candidateTestFiles(root, file, sourceFiles)) {
    const content = readFile(testFile);

    if (content === null) {
      continue;
    }

    for (const spec of importSpecifiers(content)) {
      const resolved = resolveSpecifier(testFile, spec);

      if (resolved === null) {
        continue;
      }

      // Direct (test imports the file) OR one hop (test imports a facade that does).
      if (
        resolved === target ||
        facadeImportsTarget(resolved, target, readFile)
      ) {
        return true;
      }
    }
  }

  return false;
}

export const testSiblingRequiredRule: IMetaRule = {
  id: "test-sibling-required",
  category: "testing",
  description:
    "A logic file (one that exports a function or class) the agent changes must have a test — co-located (*.test.ts) or mirrored under tests/.",
  severity: "warn",
  run({ root, changedFiles, sourceFiles, readFile }) {
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
        hasTest(root, norm) ||
        coveredByExistingTest(root, norm, sourceFiles, readFile)
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
