import { test, expect } from "bun:test";
import { join, basename } from "node:path";
import { writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";

// WS4 — the core↔adapter law made MECHANICAL. eslint.config.js forbids the generic core loop
// (`loop/**` except `loop/boringstack/**`) from importing the BoringStack adapter. WS1–WS3
// reclaimed the leaks by hand; this test proves the rule that keeps them reclaimed is LIVE — a
// leak fails `bun run validate`, not just review. It lints throwaway fixtures on the CORE side of
// the boundary (asserting adapter imports are rejected and a core import is not) AND on the ADAPTER
// side (asserting `loop/boringstack/**` is exempt via the `ignores`). One eslint spawn; both dirs
// are always removed.
//
// The fixtures must live under `loop/` to match the boundary rule's scope, but they carry
// deliberate violations — so the fixture dirs are GLOBALLY IGNORED in eslint.config.js (see the
// `__adapter_boundary_*` ignore). That makes an ORPHANED dir (SIGKILL/crash before the `finally`
// runs) invisible to a normal `eslint packages`, so it can't break a later validate; this test
// overrides the ignore with `--no-ignore` to lint the fixtures on purpose.
const ROOT = join(import.meta.dir, "..", "..", "..");
const ESLINT = join(ROOT, "node_modules", ".bin", "eslint");
const LOOP = join(ROOT, "packages", "core", "src", "loop");
// PID-suffixed so concurrent bun-test processes never share (and race on) the same directory.
const CORE_DIR = join(LOOP, `__adapter_boundary_fixture_${process.pid}__`);
const ADAPTER_DIR = join(
  LOOP,
  "boringstack",
  `__adapter_boundary_exempt_${process.pid}__`
);
const RULE = "@typescript-eslint/no-restricted-imports";
// The runtime-loader escape hatches (dynamic import(), createRequire) are caught by
// no-restricted-syntax AST selectors, not no-restricted-imports, so they report under this ruleId.
const SYNTAX_RULE = "no-restricted-syntax";

interface IFileResult {
  readonly filePath: string;
  readonly messages: readonly {
    readonly ruleId: string | null;
    readonly message: string;
  }[];
}

/** Write `core` fixtures under CORE_DIR and `adapter` fixtures under ADAPTER_DIR, lint both dirs in
 *  ONE eslint run (with `--no-ignore`, since the dirs are globally ignored), and return a map of
 *  basename → the ruleIds eslint reported. Always cleans up both dirs. */
const lintFixtures = (
  core: Record<string, string>,
  adapter: Record<string, string>
): Map<string, (string | null)[]> => {
  // Fail loudly + specifically if the eslint binary isn't where this repo puts it, rather than
  // letting a failed spawn surface as an opaque empty-stdout JSON error.
  if (!existsSync(ESLINT)) {
    throw new Error(`eslint binary not found at ${ESLINT}`);
  }

  try {
    // Create + write INSIDE the try so the finally cleanup runs even if mkdir/write throws.
    for (const [dir, files] of [
      [CORE_DIR, core],
      [ADAPTER_DIR, adapter],
    ] as const) {
      mkdirSync(dir, { recursive: true });

      for (const [name, source] of Object.entries(files)) {
        writeFileSync(join(dir, name), source);
      }
    }

    const proc = Bun.spawnSync(
      [ESLINT, "--no-ignore", "--format", "json", CORE_DIR, ADAPTER_DIR],
      { cwd: ROOT }
    );
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
      // basename() handles both / and \ separators, so keys match fixture basenames off Unix too.
      byName.set(
        basename(r.filePath),
        r.messages.map((m) => m.ruleId)
      );
    }

    return byName;
  } finally {
    rmSync(CORE_DIR, { recursive: true, force: true });
    rmSync(ADAPTER_DIR, { recursive: true, force: true });
  }
};

test("the mechanical core↔adapter boundary rejects core-loop adapter imports (static/dynamic/require), allows a core import, and exempts the adapter itself", () => {
  const results = lintFixtures(
    {
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
      "leak-require-member.ts":
        'import * as mod from "node:module";\n\nexport const m = mod.createRequire(import.meta.url)("../boringstack/plan-extension");\n',
      "enum.ts": "export enum Color {\n  Red,\n  Blue,\n}\n",
      "core-ok.ts":
        'import { isProductPlan } from "../planning/plan-store";\n\nexport const b = isProductPlan;\n',
      "leak-phaser.ts":
        'import { phaserStackAdapter } from "../phaser/planning";\n\nexport const a = phaserStackAdapter;\n',
    },
    {
      // ADAPTER side (loop/boringstack/**): a boringstack-naming import that WOULD trip the boundary
      // rule if this file were in scope — but the boundary block's `ignores` exempts the adapter, so
      // it must NOT fire. Locks the exemption: deleting the `ignores` line makes this fire → test fails.
      "adapter-internal.ts":
        'import { boringstackPlanSchema } from "../../boringstack/plan-extension";\n\nexport const a = boringstackPlanSchema;\n',
    }
  );

  // A value import of the adapter fires the boundary rule.
  expect(results.get("leak-value.ts")).toContain(RULE);
  expect(results.get("leak-phaser.ts")).toContain(RULE);
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
  // no-restricted-syntax selectors, which cover the string, templated, AND `module.createRequire`
  // member forms.
  expect(results.get("leak-require.ts")).toContain(SYNTAX_RULE);
  expect(results.get("leak-require-template.ts")).toContain(SYNTAX_RULE);
  expect(results.get("leak-require-member.ts")).toContain(SYNTAX_RULE);
  // The boundary block REPLACES the base no-restricted-syntax for loop files, re-including the
  // enum ban. Prove that ban still fires here, so a future edit dropping the TSEnumDeclaration
  // selector can't silently relax the gate for the whole core loop.
  expect(results.get("enum.ts")).toContain(SYNTAX_RULE);
  // Importing another CORE module is allowed — the rule targets only the adapter subtree, so it
  // is a real boundary, not a blanket ban that would also block legitimate intra-core imports.
  // Assert the control file was ACTUALLY linted first (a missing entry — ignored / mis-scoped /
  // basename mismatch — must fail, not green-wash the negative case).
  const coreOk = results.get("core-ok.ts");

  expect(coreOk).toBeDefined();
  expect(coreOk).not.toContain(RULE);
  expect(coreOk).not.toContain(SYNTAX_RULE);
  // The ADAPTER'S OWN file is exempt (via the boundary block's `ignores`) even though it names a
  // boringstack path — proven linted (defined) and not flagged. This locks the `ignores` line.
  const adapterInternal = results.get("adapter-internal.ts");

  expect(adapterInternal).toBeDefined();
  expect(adapterInternal).not.toContain(RULE);
  expect(adapterInternal).not.toContain(SYNTAX_RULE);
}, 30000);

test("the fixture dirs are GLOBALLY IGNORED (crash-orphan safety): a leak there is skipped by a normal lint", () => {
  // The main test lints with `--no-ignore`, so it never proves the global ignore actually works. A
  // broken/ineffective ignore pattern would leave an orphaned crash fixture linted by every later
  // `eslint packages` — a real footgun. Here we lint a fixture WITHOUT `--no-ignore` (as validate
  // does) and assert eslint reports it as IGNORED, not as a boundary violation.
  if (!existsSync(ESLINT)) {
    throw new Error(`eslint binary not found at ${ESLINT}`);
  }

  const file = join(CORE_DIR, "orphan-leak.ts");

  try {
    mkdirSync(CORE_DIR, { recursive: true });
    writeFileSync(
      file,
      'import { boringstackPlanSchema } from "../boringstack/plan-extension";\n\nexport const a = boringstackPlanSchema;\n'
    );

    const proc = Bun.spawnSync([ESLINT, "--format", "json", file], {
      cwd: ROOT,
    });
    let parsed: IFileResult[];

    try {
      parsed = JSON.parse(proc.stdout.toString());
    } catch {
      throw new Error(
        `eslint did not emit a JSON report (exit ${proc.exitCode}). stderr: ${proc.stderr.toString()} | stdout: ${proc.stdout.toString()}`
      );
    }

    const messages = parsed.flatMap((r) => r.messages);
    const ruleIds = messages.map((m) => m.ruleId);

    // The boundary rules must NOT have run (the file was ignored, not linted)…
    expect(ruleIds).not.toContain(RULE);
    expect(ruleIds).not.toContain(SYNTAX_RULE);
    // …and eslint must positively report it as ignored, proving the ignore PATTERN matched (a clean
    // file with no messages could also satisfy the negative asserts above — this rules that out).
    expect(messages.some((m) => m.message.includes("ignored"))).toBe(true);
  } finally {
    rmSync(CORE_DIR, { recursive: true, force: true });
  }
}, 30000);
