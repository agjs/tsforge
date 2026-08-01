import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";

// WS4 — the core↔adapter law made MECHANICAL. eslint.config.js forbids the generic core loop
// (`loop/**` except `loop/boringstack/**`) from importing the BoringStack adapter. WS1–WS3
// reclaimed the leaks by hand; this test proves the rule that keeps them reclaimed is LIVE — a
// leak fails `bun run validate`, not just review. It lints throwaway fixtures placed on the CORE
// side of the boundary (under `loop/`, NOT under `loop/boringstack/`) and asserts the rule fires
// on static / type-only / dynamic (literal + templated) adapter imports and stays silent on a core
// import. One eslint spawn (one TS-program load) over all fixtures; the fixture dir is always removed.
const ROOT = join(import.meta.dir, "..", "..", "..");
const ESLINT = join(ROOT, "node_modules", ".bin", "eslint");
// Suffix the fixture dir with the worker PID so concurrent bun-test processes never share (and
// race on write/lint/rm of) the same directory.
const FIXTURE_DIR = join(
  ROOT,
  "packages",
  "core",
  "src",
  "loop",
  `__adapter_boundary_fixture_${process.pid}__`
);
const RULE = "@typescript-eslint/no-restricted-imports";
// The dynamic-import escape hatch (`import("../boringstack/x")`) is caught by a no-restricted-syntax
// AST selector, not no-restricted-imports, so it reports under a different ruleId.
const SYNTAX_RULE = "no-restricted-syntax";

interface IFileResult {
  readonly filePath: string;
  readonly messages: readonly { readonly ruleId: string | null }[];
}

/** Write the given `{ name: source }` fixtures under FIXTURE_DIR, lint the dir ONCE, and return a
 *  map of basename → the ruleIds eslint reported for that file. Always cleans up. */
const lintFixtures = (
  files: Record<string, string>
): Map<string, (string | null)[]> => {
  // Fail loudly + specifically if the eslint binary isn't where this repo puts it, rather than
  // letting a failed spawn surface as an opaque empty-stdout JSON error.
  if (!existsSync(ESLINT)) {
    throw new Error(`eslint binary not found at ${ESLINT}`);
  }

  try {
    // Create + write INSIDE the try so the finally cleanup runs even if mkdir/write throws.
    mkdirSync(FIXTURE_DIR, { recursive: true });

    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(FIXTURE_DIR, name), source);
    }

    const proc = Bun.spawnSync([ESLINT, "--format", "json", FIXTURE_DIR], {
      cwd: ROOT,
    });
    const stdout = proc.stdout.toString();
    // eslint EXITS NON-ZERO here (the fixtures have lint errors — that's the point), but still
    // writes its JSON report to stdout. A crash (missing binary, config load failure) instead
    // yields empty/non-JSON stdout; surface THAT as a clear failure, not a cryptic JSON.parse throw.
    let parsed: IFileResult[];

    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(
        `eslint did not emit a JSON report (exit ${proc.exitCode}). stderr: ${proc.stderr.toString()} | stdout: ${stdout}`
      );
    }

    const byName = new Map<string, (string | null)[]>();

    for (const r of parsed) {
      byName.set(
        r.filePath.split("/").pop() ?? r.filePath,
        r.messages.map((m) => m.ruleId)
      );
    }

    return byName;
  } finally {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
};

test("the mechanical core↔adapter boundary rejects a core-loop import of loop/boringstack (value + type + dynamic) and allows a core import", () => {
  const results = lintFixtures({
    "leak-value.ts":
      'import { boringstackPlanSchema } from "../boringstack/plan-extension";\n\nexport const a = boringstackPlanSchema;\n',
    "leak-type.ts":
      'import type { IUiIntent } from "../boringstack/plan-extension";\n\nexport type A = IUiIntent;\n',
    "leak-reexport.ts":
      'export { boringstackPlanSchema } from "../boringstack/plan-extension";\n',
    "leak-dynamic.ts":
      'export async function load() {\n  return import("../boringstack/plan-extension");\n}\n',
    "leak-dynamic-template.ts":
      "export async function load() {\n  return import(`../boringstack/plan-extension`);\n}\n",
    "leak-dynamic-concat.ts":
      'export async function load() {\n  return import("../boringstack/" + "plan-extension");\n}\n',
    "leak-dynamic-ternary.ts":
      'export async function load(b: boolean) {\n  return import(b ? "../boringstack/plan-extension" : "../planning/plan-store");\n}\n',
    "leak-require.ts":
      'import { createRequire } from "node:module";\n\nexport const m = createRequire(import.meta.url)("../boringstack/plan-extension");\n',
    "leak-require-template.ts":
      'import { createRequire } from "node:module";\n\nexport const m = createRequire(import.meta.url)(`../boringstack/plan-extension`);\n',
    "enum.ts": "export enum Color {\n  Red,\n  Blue,\n}\n",
    "core-ok.ts":
      'import { isProductPlan } from "../planning/plan-store";\n\nexport const b = isProductPlan;\n',
  });

  // A value import of the adapter fires the boundary rule.
  expect(results.get("leak-value.ts")).toContain(RULE);
  // A TYPE-ONLY import of the adapter fires it too — the @typescript-eslint superset of
  // no-restricted-imports catches `import type`, which core no-restricted-imports would miss.
  expect(results.get("leak-type.ts")).toContain(RULE);
  // A static RE-EXPORT (`export { x } from "../boringstack/y"`) is a restricted import too.
  expect(results.get("leak-reexport.ts")).toContain(RULE);
  // DYNAMIC import() forms are caught by the no-restricted-syntax selectors (no-restricted-imports
  // doesn't see dynamic imports): plain string, templated, string CONCAT, and a TERNARY arg — each
  // a form a narrower selector could evade.
  expect(results.get("leak-dynamic.ts")).toContain(SYNTAX_RULE);
  expect(results.get("leak-dynamic-template.ts")).toContain(SYNTAX_RULE);
  expect(results.get("leak-dynamic-concat.ts")).toContain(SYNTAX_RULE);
  expect(results.get("leak-dynamic-ternary.ts")).toContain(SYNTAX_RULE);
  // An immediately-invoked createRequire(...)(...) (CommonJS-interop runtime load) is caught too —
  // no-restricted-imports only sees the permitted `node:module` import, so the ban lives in the
  // no-restricted-syntax selectors, which cover the string AND templated createRequire forms.
  expect(results.get("leak-require.ts")).toContain(SYNTAX_RULE);
  expect(results.get("leak-require-template.ts")).toContain(SYNTAX_RULE);
  // The boundary block REPLACES the base no-restricted-syntax for loop files, re-including the
  // enum ban. Prove that ban still fires here, so a future edit dropping the TSEnumDeclaration
  // selector can't silently relax the gate for the whole core loop.
  expect(results.get("enum.ts")).toContain(SYNTAX_RULE);
  // Importing another CORE module is allowed — the rule targets only the adapter subtree, so it
  // is a real boundary, not a blanket ban that would also block legitimate intra-core imports.
  // Assert the control file was ACTUALLY linted first (a missing entry — ignored / mis-scoped /
  // basename mismatch — must fail, not green-wash the negative case via a `?? []` default).
  const coreOk = results.get("core-ok.ts");

  expect(coreOk).toBeDefined();
  expect(coreOk).not.toContain(RULE);
  expect(coreOk).not.toContain(SYNTAX_RULE);
}, 30000);
