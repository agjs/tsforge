import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TsService } from "../src/lsp";

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    noUncheckedIndexedAccess: true,
    noUnusedLocals: true,
    target: "ES2022",
    module: "ES2022",
    moduleResolution: "node",
    skipLibCheck: true,
  },
  include: ["*.ts"],
});

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-lsp-"));

  await Bun.write(join(dir, "tsconfig.json"), TSCONFIG);

  for (const [name, content] of Object.entries(files)) {
    await Bun.write(join(dir, name), content);
  }

  return dir;
}

test("diagnostics reports semantic type errors with their TS codes", async () => {
  const dir = await project({
    "a.ts": 'export const n: number = "not a number";\n',
  });

  try {
    const svc = new TsService(dir);
    const diags = svc.diagnostics("a.ts");

    expect(diags.some((d) => d.code === 2322)).toBe(true); // not assignable
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("quickFixes offers TypeScript's own fix for a fixable error", async () => {
  // Unused local → TS offers "remove unused declaration".
  const dir = await project({
    "a.ts": "const unused = 1;\nexport const y = 2;\n",
  });

  try {
    const svc = new TsService(dir);
    const fixes = svc.quickFixes("a.ts");

    expect(fixes.length).toBeGreaterThan(0);
    expect(
      fixes
        .map((f) => f.description)
        .join(" ")
        .toLowerCase()
    ).toContain("unused");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fixAll applies TypeScript's safe quick-fixes (removes an unused local)", async () => {
  const dir = await project({
    "a.ts": "const unused = 1;\nexport const y = 2;\n",
  });

  try {
    const svc = new TsService(dir);
    const applied = svc.fixAll("a.ts");

    expect(applied).toBeGreaterThan(0);
    expect(svc.diagnostics("a.ts")).toHaveLength(0); // cleared
    expect(await Bun.file(join(dir, "a.ts")).text()).not.toContain("unused");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fixAll adds a missing import (fixMissingImport)", async () => {
  const dir = await project({
    "b.ts": "export function foo(): number {\n  return 1;\n}\n",
    "a.ts": "export const z = foo();\n",
  });

  try {
    const svc = new TsService(dir);

    svc.fixAll("a.ts");

    const fixed = await Bun.file(join(dir, "a.ts")).text();

    expect(fixed).toContain("import");
    expect(fixed).toContain("./b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fixAll does NOT invent empty property stubs for missing fields", async () => {
  // Dogfood: Artist gained followers/following → tsFixAll's fixMissingProperties
  // stubbed `followers: [], following: []` into seed data, gate went green, model
  // then thrashed replacing identical empty arrays. Missing required fields must
  // stay as diagnostics for the model to fill with real data.
  const dir = await project({
    "types.ts":
      "export type Artist = { id: string; followers: string[]; following: string[] };\n",
    "seed.ts":
      'import type { Artist } from "./types";\n' +
      'export const seed: Artist[] = [{ id: "a1" }];\n',
  });

  try {
    const svc = new TsService(dir);
    const before = await Bun.file(join(dir, "seed.ts")).text();
    const applied = svc.fixAll("seed.ts");
    const after = await Bun.file(join(dir, "seed.ts")).text();

    expect(after).toBe(before);
    expect(applied).toBe(0);
    expect(svc.diagnostics("seed.ts").some((d) => d.code === 2739)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("typeAt returns the type at a position", async () => {
  const dir = await project({ "a.ts": "export const v = 41 + 1;\n" });

  try {
    const svc = new TsService(dir);
    // position of `v`
    const src = await Bun.file(join(dir, "a.ts")).text();
    const info = svc.typeAt("a.ts", src.indexOf("v"));

    expect(info).toContain("number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
