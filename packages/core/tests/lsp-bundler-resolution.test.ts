import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TsService } from "../src/lsp";

// The `orders` seed uses moduleResolution "bundler" + noUnusedLocals — the plan
// flagged bundler resolution as the risk that could stop the LanguageService
// from computing import specifiers. This pins down, deterministically (no model,
// no GPU), that tsFixAll DOES real work on that config: it adds a missing
// relative import and removes an unused local. This is where the LSP earns its
// keep — unlike `money` (single-file algebra), which has no safe-fixable errors.
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ES2022",
    moduleResolution: "bundler",
    strict: true,
    noUncheckedIndexedAccess: true,
    noUnusedLocals: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["*.ts"],
});

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-bundler-"));

  await Bun.write(join(dir, "tsconfig.json"), TSCONFIG);

  for (const [name, content] of Object.entries(files)) {
    await Bun.write(join(dir, name), content);
  }

  return dir;
}

test("tsFixAll adds a missing relative import under bundler resolution", async () => {
  const dir = await project({
    "types.ts": "export interface ILineItem {\n  unitCents: number;\n}\n",
    // Uses ILineItem with NO import → TS2304 → fixMissingImport should add it.
    "subtotal.ts":
      "export function subtotal(items: ILineItem[]): number {\n" +
      "  return items.reduce((acc: number, it: ILineItem) => acc + it.unitCents, 0);\n" +
      "}\n",
  });

  try {
    const svc = new TsService(dir);

    // Sanity: the LanguageService initialized on the bundler config and SEES
    // the missing-name error (proves it didn't silently fail to load).
    expect(svc.diagnostics("subtotal.ts").some((d) => d.code === 2304)).toBe(
      true
    );

    const applied = svc.fixAll("subtotal.ts");

    expect(applied).toBeGreaterThan(0);

    const fixed = await Bun.file(join(dir, "subtotal.ts")).text();

    expect(fixed).toContain("import");
    expect(fixed).toContain("./types");
    // And the error it was fixing is gone.
    expect(svc.diagnostics("subtotal.ts").some((d) => d.code === 2304)).toBe(
      false
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tsFixAll removes an unused local under bundler resolution (noUnusedLocals)", async () => {
  const dir = await project({
    "tax.ts":
      "export function taxCents(amountCents: number, ratePct: number): number {\n" +
      "  const unused = 42;\n" +
      "  return Math.round((amountCents * ratePct) / 100);\n" +
      "}\n",
  });

  try {
    const svc = new TsService(dir);

    expect(svc.fixAll("tax.ts")).toBeGreaterThan(0);
    expect(await Bun.file(join(dir, "tax.ts")).text()).not.toContain("unused");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
