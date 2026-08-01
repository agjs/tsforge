import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";

// WS4 — the core↔adapter law made MECHANICAL. eslint.config.js forbids the generic core loop
// (`loop/**` except `loop/boringstack/**`) from importing the BoringStack adapter. WS1–WS3
// reclaimed the leaks by hand; this test proves the rule that keeps them reclaimed is LIVE — a
// leak fails `bun run validate`, not just review. It lints throwaway fixtures placed on the CORE
// side of the boundary (under `loop/`, NOT under `loop/boringstack/`) and asserts the rule fires
// on an adapter import and stays silent on a core import. One eslint spawn (one TS-program load)
// over all three fixtures; the fixture dir is always removed.
const ROOT = join(import.meta.dir, "..", "..", "..");
const ESLINT = join(ROOT, "node_modules", ".bin", "eslint");
const FIXTURE_DIR = join(
  ROOT,
  "packages",
  "core",
  "src",
  "loop",
  "__adapter_boundary_fixture__"
);
const RULE = "@typescript-eslint/no-restricted-imports";

interface IFileResult {
  readonly filePath: string;
  readonly messages: readonly { readonly ruleId: string | null }[];
}

/** Write the given `{ name: source }` fixtures under FIXTURE_DIR, lint the dir ONCE, and return a
 *  map of basename → the ruleIds eslint reported for that file. Always cleans up. */
const lintFixtures = (
  files: Record<string, string>
): Map<string, (string | null)[]> => {
  mkdirSync(FIXTURE_DIR, { recursive: true });

  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(FIXTURE_DIR, name), source);
  }

  try {
    const proc = Bun.spawnSync([ESLINT, "--format", "json", FIXTURE_DIR], {
      cwd: ROOT,
    });
    const parsed: IFileResult[] = JSON.parse(proc.stdout.toString());
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

test("the mechanical core↔adapter boundary rejects a core-loop import of loop/boringstack (value + type) and allows a core import", () => {
  const results = lintFixtures({
    "leak-value.ts":
      'import { boringstackPlanSchema } from "../boringstack/plan-extension";\n\nexport const a = boringstackPlanSchema;\n',
    "leak-type.ts":
      'import type { IUiIntent } from "../boringstack/plan-extension";\n\nexport type A = IUiIntent;\n',
    "core-ok.ts":
      'import { isProductPlan } from "../planning/plan-store";\n\nexport const b = isProductPlan;\n',
  });

  // A value import of the adapter fires the boundary rule.
  expect(results.get("leak-value.ts")).toContain(RULE);
  // A TYPE-ONLY import of the adapter fires it too — the @typescript-eslint superset of
  // no-restricted-imports catches `import type`, which core no-restricted-imports would miss.
  expect(results.get("leak-type.ts")).toContain(RULE);
  // Importing another CORE module is allowed — the rule targets only the adapter subtree, so it
  // is a real boundary, not a blanket ban that would also block legitimate intra-core imports.
  expect(results.get("core-ok.ts") ?? []).not.toContain(RULE);
}, 30000);
