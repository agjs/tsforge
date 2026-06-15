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

// P1: organize_imports' schema requires only `file`, so a `{file}`-only call must
// REACH the operation — it must not be rejected with "need {file, symbol}".
test("organize_imports runs with only `file` (no symbol required)", async () => {
  const ctx = await setup(["types.ts", "use.ts"]);

  try {
    // An unused import → organize_imports should drop it.
    await Bun.write(
      join(ctx.cwd, "use.ts"),
      'import type { IThing } from "./types";\nimport { f as unused } from "./types";\nexport const f = (t: IThing): number => t.value;\n'
    );

    const r = await executeTool(
      { name: "organize_imports", arguments: { file: "use.ts" } },
      ctx
    );

    expect(r).toContain("organize_imports:");
    expect(r).not.toContain("need");
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("organize_imports is REJECTED for an out-of-scope file", async () => {
  const ctx = await setup(["types.ts"]); // use.ts read-only

  try {
    const r = await executeTool(
      { name: "organize_imports", arguments: { file: "use.ts" } },
      ctx
    );

    expect(r).toContain("REJECTED");
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

// P2 (security): the search pattern comes from the model, so it must be passed
// to rg as a literal argv element — a `$(…)` in it must NOT execute via a shell.
test("search does not shell-expand the pattern", async () => {
  const ctx = await setup(["types.ts", "use.ts"]);

  try {
    await Bun.write(join(ctx.cwd, "marker.txt"), "owned");

    // If this ran through `sh -c`, the $(…) would create pwned.txt. With argv it
    // is just a (non-matching) search string.
    const r = await executeTool(
      { name: "search", arguments: { pattern: "$(touch pwned.txt)" } },
      ctx
    );

    expect(await Bun.file(join(ctx.cwd, "pwned.txt")).exists()).toBe(false);
    expect(r).toContain("no matches");
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("search finds a literal match across files", async () => {
  const ctx = await setup(["types.ts", "use.ts"]);

  try {
    const r = await executeTool(
      { name: "search", arguments: { pattern: "IThing" } },
      ctx
    );

    expect(r).toContain("types.ts");
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("move_file relocates a file and rewrites every importer's specifier", async () => {
  const ctx = await setup(["types.ts", "use.ts", "lib/types.ts"]);

  try {
    const r = await executeTool(
      {
        name: "move_file",
        arguments: { from: "types.ts", to: "lib/types.ts" },
      },
      ctx
    );

    expect(r).toContain("moved");
    // File physically moved.
    expect(await Bun.file(join(ctx.cwd, "lib/types.ts")).exists()).toBe(true);
    expect(await Bun.file(join(ctx.cwd, "types.ts")).exists()).toBe(false);
    // Importer's specifier rewritten to the new location.
    expect(await Bun.file(join(ctx.cwd, "use.ts")).text()).toContain(
      "lib/types"
    );
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("move_file is REJECTED when an importer is out of editable scope", async () => {
  // Only the source + destination are editable; use.ts (an importer) is read-only.
  const ctx = await setup(["types.ts", "lib/types.ts"]);

  try {
    const r = await executeTool(
      {
        name: "move_file",
        arguments: { from: "types.ts", to: "lib/types.ts" },
      },
      ctx
    );

    expect(r).toContain("REJECTED");
    expect(r).toContain("use.ts");
    // Nothing moved.
    expect(await Bun.file(join(ctx.cwd, "types.ts")).exists()).toBe(true);
    expect(await Bun.file(join(ctx.cwd, "lib/types.ts")).exists()).toBe(false);
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("move_file is REJECTED when the destination is vendored (read-only)", async () => {
  const ctx: IToolContext = {
    ...(await setup(["types.ts", "use.ts", "lib/types.ts"])),
    vendored: ["lib/**"],
  };

  try {
    const r = await executeTool(
      {
        name: "move_file",
        arguments: { from: "types.ts", to: "lib/types.ts" },
      },
      ctx
    );

    expect(r).toContain("REJECTED");
    expect(await Bun.file(join(ctx.cwd, "types.ts")).exists()).toBe(true);
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
