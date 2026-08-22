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

test("go_to_definition from a use site points at the declaration file", async () => {
  const ctx = await setup(["types.ts", "use.ts"]);

  try {
    const r = await executeTool(
      {
        name: "go_to_definition",
        arguments: { file: "use.ts", symbol: "IThing" },
      },
      ctx
    );

    expect(r).toContain("types.ts:");
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("impact lists dependent files and excludes declaration-only self-ref", async () => {
  const ctx = await setup(["types.ts", "use.ts"]);

  try {
    const r = await executeTool(
      { name: "impact", arguments: { file: "types.ts", symbol: "IThing" } },
      ctx
    );

    expect(r).toContain("use.ts");
    expect(r).toMatch(/\d+ reference\(s\) in \d+ file\(s\)/);
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("symbol_context bundles type, definition, and references", async () => {
  const ctx = await setup(["types.ts", "use.ts"]);

  try {
    const r = await executeTool(
      {
        name: "symbol_context",
        arguments: { file: "use.ts", symbol: "IThing" },
      },
      ctx
    );

    expect(r).toContain("type:");
    expect(r).toContain("definition:");
    expect(r).toContain("types.ts:");
    expect(r).toContain("references (");
    expect(r).toContain("use.ts:");
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

// organize_imports scope-checked the RAW model argument while edit/create/
// edit_lines all normalize first, so an in-scope file addressed absolutely or as
// "./x" was rejected as out of scope by this tool alone — the manifest's stated
// risk for this subsystem ("scope check on the raw arg instead of the normalized
// written path"). Models emit both forms routinely.
test("organize_imports accepts an in-scope file addressed absolutely or as ./", async () => {
  const ctx = await setup(["types.ts", "a.ts", "b.ts"]);
  const dirty =
    'import type { IThing } from "./types";\nimport { f as unused } from "./types";\nexport const f = (t: IThing): number => t.value;\n';

  try {
    // A separate file per form: sharing one would make the second call a no-op
    // after the first succeeded, so it would pass without proving anything.
    await Bun.write(join(ctx.cwd, "a.ts"), dirty);
    await Bun.write(join(ctx.cwd, "b.ts"), dirty);

    const reported: string[] = [];
    const spy: IToolContext = {
      ...ctx,
      // setup() builds its TsService before these files exist, so it would not
      // know them — rebuild after writing.
      tsService: new TsService(ctx.cwd),
      report: (event) => {
        reported.push(...(event.mutated ?? []));
      },
    };

    for (const [file, name] of [
      [join(ctx.cwd, "a.ts"), "a.ts"],
      ["./b.ts", "b.ts"],
    ] as const) {
      const r = await executeTool(
        { name: "organize_imports", arguments: { file } },
        spy
      );

      expect({ file, rejected: r.includes("REJECTED") }).toEqual({
        file,
        rejected: false,
      });
      // It must actually operate on the file, not merely pass the scope check:
      // a fix that normalized only for the check and passed the raw path
      // downstream would leave the unused import in place.
      expect({
        name,
        text: await Bun.file(join(ctx.cwd, name)).text(),
      }).toEqual({
        name,
        text: 'import type { IThing } from "./types";\nexport const f = (t: IThing): number => t.value;\n',
      });
    }

    // The change scope records the NORMALIZED path, matching what edit/create
    // report — not the absolute or "./" form the model happened to send.
    expect([...reported].sort()).toEqual(["a.ts", "b.ts"]);
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

// A path that ESCAPES the workspace must still be rejected — normalizing must
// not become a way in.
test("organize_imports still rejects a traversal path", async () => {
  const ctx = await setup(["use.ts"]);

  try {
    const r = await executeTool(
      { name: "organize_imports", arguments: { file: "../outside.ts" } },
      ctx
    );

    expect(r).toContain("REJECTED");
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
