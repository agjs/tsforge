import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TsService } from "../src/lsp";

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ES2022",
    moduleResolution: "bundler",
    strict: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
  },
  include: ["*.ts"],
});

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nav-"));

  await Bun.write(join(dir, "tsconfig.json"), TSCONFIG);

  for (const [name, content] of Object.entries(files)) {
    await Bun.write(join(dir, name), content);
  }

  return dir;
}

// A 3-file project with a shared type used across files.
function graph(): Record<string, string> {
  return {
    "types.ts": "export interface IThing {\n  value: number;\n}\n",
    "a.ts":
      'import type { IThing } from "./types";\nexport const a = (t: IThing): number => t.value + 1;\n',
    "b.ts":
      'import type { IThing } from "./types";\nexport const b = (t: IThing): number => t.value * 2;\n',
  };
}

test("references finds a symbol's uses across files", async () => {
  const dir = await project(graph());

  try {
    const svc = new TsService(dir);
    const pos = svc.positionOfSymbol("types.ts", "IThing");

    expect(pos).not.toBeUndefined();

    const refs = svc.references("types.ts", pos ?? 0);
    const files = new Set(refs.map((r) => r.file.split("/").slice(-1)[0]));

    // Declared in types.ts, imported+used in a.ts and b.ts.
    expect(files.has("types.ts")).toBe(true);
    expect(files.has("a.ts")).toBe(true);
    expect(files.has("b.ts")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("symbols (workspace search) locates a symbol by name", async () => {
  const dir = await project(graph());

  try {
    const svc = new TsService(dir);
    const hits = svc.symbols("IThing");

    expect(hits.some((h) => h.name === "IThing")).toBe(true);
    expect(
      hits.some((h) => h.file.split("/").slice(-1)[0] === "types.ts")
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rename updates the symbol across ALL files", async () => {
  const dir = await project(graph());

  try {
    const svc = new TsService(dir);
    const pos = svc.positionOfSymbol("types.ts", "IThing");
    const changed = svc.rename("types.ts", pos ?? 0, "IWidget");

    expect(changed).not.toBeNull();
    expect(changed ?? 0).toBeGreaterThanOrEqual(3); // decl + 2 usages

    for (const f of ["types.ts", "a.ts", "b.ts"]) {
      const text = await Bun.file(join(dir, f)).text();

      expect(text).toContain("IWidget");
      expect(text).not.toContain("IThing");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renameTargets lists the files a rename would touch (for scope-checking)", async () => {
  const dir = await project(graph());

  try {
    const svc = new TsService(dir);
    const pos = svc.positionOfSymbol("types.ts", "IThing");
    const targets = svc
      .renameTargets("types.ts", pos ?? 0)
      .map((t) => t.split("/").slice(-1)[0]);

    expect(new Set(targets)).toEqual(new Set(["types.ts", "a.ts", "b.ts"]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("definition jumps from a usage to the declaration", async () => {
  const dir = await project(graph());

  try {
    const svc = new TsService(dir);
    // position of IThing where it's USED in a.ts (the type annotation)
    const pos = svc.positionOfSymbol("a.ts", "IThing");
    const defs = svc.definition("a.ts", pos ?? 0);

    expect(
      defs.some((d) => d.file.split("/").slice(-1)[0] === "types.ts")
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("organizeImports removes an unused import", async () => {
  const dir = await project({
    "util.ts": "export const used = 1;\nexport const extra = 2;\n",
    "main.ts":
      'import { used, extra } from "./util";\nexport const z = used + 1;\n',
  });

  try {
    const svc = new TsService(dir);

    expect(svc.organizeImports("main.ts")).toBeGreaterThan(0);

    const text = await Bun.file(join(dir, "main.ts")).text();

    expect(text).toContain("used");
    expect(text).not.toContain("extra"); // unused import dropped
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
