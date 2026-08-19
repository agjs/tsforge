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

test("impact reports the blast radius (dependant files), excluding the declaration", async () => {
  const dir = await project(graph());

  try {
    const svc = new TsService(dir);
    const pos = svc.positionOfSymbol("types.ts", "IThing");
    const impact = svc.impact("types.ts", pos ?? 0);
    const files = new Set(
      impact.files.map((f) => f.file.split("/").slice(-1)[0])
    );

    // IThing is used in a.ts and b.ts; its own declaration is excluded.
    expect(impact.fileCount).toBe(2);
    expect(files).toEqual(new Set(["a.ts", "b.ts"]));
    expect(files.has("types.ts")).toBe(false);
    expect(impact.total).toBeGreaterThanOrEqual(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("context composes type + definition + references in one call", async () => {
  const dir = await project(graph());

  try {
    const svc = new TsService(dir);
    const pos = svc.positionOfSymbol("a.ts", "IThing");
    const ctx = svc.context("a.ts", pos ?? 0);

    expect(ctx.type.length).toBeGreaterThan(0);
    expect(
      ctx.definition.some((d) => d.file.split("/").slice(-1)[0] === "types.ts")
    ).toBe(true);
    expect(ctx.references.length).toBeGreaterThanOrEqual(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dependantErrors reports a caller broken by a dependency's signature", async () => {
  const dir = await project({
    "lib.ts":
      "export function f(a: number, b: number): number {\n  return a + b;\n}\n",
    "caller.ts": 'import { f } from "./lib";\nexport const x = f(1);\n', // missing arg
    "ok.ts": 'import { f } from "./lib";\nexport const y = f(1, 2);\n', // correct
  });

  try {
    const svc = new TsService(dir);
    const broken = svc.dependantErrors("lib.ts");
    const files = broken.map((b) => b.file.split("/").slice(-1)[0]);

    // caller.ts (wrong arity) is in the blast radius; ok.ts is not.
    expect(files).toContain("caller.ts");
    expect(files).not.toContain("ok.ts");
    expect(broken.some((b) => b.errors.some((e) => e.code === 2554))).toBe(
      true
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dependantErrors is empty when nothing downstream is broken", async () => {
  const dir = await project({
    "lib.ts": "export const k = 1;\n",
    "use.ts": 'import { k } from "./lib";\nexport const z = k + 1;\n',
  });

  try {
    const svc = new TsService(dir);

    expect(svc.dependantErrors("lib.ts")).toEqual([]);
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

test("positionOfSymbol resolves a real token, not a same-named comment or string", async () => {
  // A `\b`-regex matched the FIRST textual occurrence, so a name in a comment or
  // string literal that appeared before the declaration won — getReferences at
  // that offset finds no symbol, the tool reports "no references", and the model
  // deletes a live symbol as dead. The resolver must land on an identifier token.
  const dir = await project({
    "types.ts":
      "// A User record used across the whole app.\n" + // 'User' in a comment, FIRST
      'const label = "User settings panel";\n' + // 'User' inside a string
      "export interface User {\n  id: number;\n}\n", // the real declaration
    "a.ts":
      'import type { User } from "./types";\n' +
      "export const u = (x: User): number => x.id;\n",
  });

  try {
    const svc = new TsService(dir);
    const pos = svc.positionOfSymbol("types.ts", "User");

    expect(pos).not.toBeUndefined();

    // The offset resolves to a symbol TS can follow — references finds the
    // cross-file use (the old regex offset, inside the comment, found none).
    const refs = svc.references("types.ts", pos ?? 0);
    const files = new Set(refs.map((r) => r.file.split("/").slice(-1)[0]));

    expect(files.has("types.ts")).toBe(true);
    expect(files.has("a.ts")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("positionOfSymbol returns undefined when the name is ONLY in a comment/string", async () => {
  // No identifier token of that name anywhere → honestly undefined (the tool
  // then says 'no such symbol'), not a comment offset that silently resolves to
  // nothing downstream.
  const dir = await project({
    "only.ts": '// mentions Ghost in a comment\nconst s = "Ghost here too";\n',
  });

  try {
    const svc = new TsService(dir);

    expect(svc.positionOfSymbol("only.ts", "Ghost")).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
