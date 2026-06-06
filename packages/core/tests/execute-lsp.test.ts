import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../src/loop/tools/execute-tool";
import type { IToolContext } from "../src/loop/tools/execute-tool";
import { TsService } from "../src/lsp";

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ES2022",
    moduleResolution: "bundler",
    strict: true,
    skipLibCheck: true,
  },
  include: ["*.ts"],
});

async function setup(files: string[]): Promise<IToolContext> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-elsp-"));

  await Bun.write(join(dir, "tsconfig.json"), TSCONFIG);
  await Bun.write(
    join(dir, "types.ts"),
    "export interface IThing {\n  value: number;\n}\n"
  );
  await Bun.write(
    join(dir, "use.ts"),
    'import type { IThing } from "./types";\nexport const f = (t: IThing): number => t.value;\n'
  );

  return {
    cwd: dir,
    files,
    task: "t",
    report: () => undefined,
    tsService: new TsService(dir),
  };
}

test("find_references tool lists uses across files", async () => {
  const ctx = await setup(["types.ts", "use.ts"]);

  try {
    const r = await executeTool(
      {
        name: "find_references",
        arguments: { file: "types.ts", symbol: "IThing" },
      },
      ctx
    );

    expect(r).toContain("types.ts:");
    expect(r).toContain("use.ts:");
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("type_at tool returns the type of a symbol", async () => {
  const ctx = await setup(["types.ts", "use.ts"]);

  try {
    const r = await executeTool(
      { name: "type_at", arguments: { file: "use.ts", symbol: "f" } },
      ctx
    );

    expect(r.toLowerCase()).toContain("ithing");
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("rename_symbol applies across files when all refs are in scope", async () => {
  const ctx = await setup(["types.ts", "use.ts"]);

  try {
    const r = await executeTool(
      {
        name: "rename_symbol",
        arguments: { file: "types.ts", symbol: "IThing", newName: "IWidget" },
      },
      ctx
    );

    expect(r).toContain("renamed");
    expect(await Bun.file(join(ctx.cwd, "use.ts")).text()).toContain("IWidget");
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("rename_symbol is REJECTED when a reference is out of editable scope", async () => {
  // Only types.ts is editable; IThing is also referenced in use.ts (read-only).
  const ctx = await setup(["types.ts"]);

  try {
    const r = await executeTool(
      {
        name: "rename_symbol",
        arguments: { file: "types.ts", symbol: "IThing", newName: "IWidget" },
      },
      ctx
    );

    expect(r).toContain("REJECTED");
    expect(r).toContain("use.ts");
    // Nothing changed.
    expect(await Bun.file(join(ctx.cwd, "types.ts")).text()).toContain(
      "IThing"
    );
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("semantic tools degrade gracefully without a TsService", async () => {
  const ctx = await setup(["types.ts"]);
  const noLsp: IToolContext = { ...ctx, tsService: null };

  try {
    const r = await executeTool(
      {
        name: "find_references",
        arguments: { file: "types.ts", symbol: "IThing" },
      },
      noLsp
    );

    expect(r).toContain("unavailable");
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});
