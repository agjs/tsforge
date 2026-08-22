import { test, expect } from "bun:test";
import {
  filterFiles,
  filterMentionItems,
  formatCompletionRows,
  mentionInsertText,
  truncatePath,
  shouldOpenAtPicker,
  type IMentionItem,
} from "../src/render/file-menu";
import { TsService } from "../src/lsp";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILES = [
  "src/cli.ts",
  "src/render/status-bar.ts",
  "components/navbar.tsx",
  "bar.ts",
  "README.md",
];

test("filterFiles: empty query returns the caller's order, capped tight (8)", () => {
  expect(filterFiles(FILES, "")).toEqual(FILES); // fewer than the cap ⇒ all, in order

  const many = Array.from({ length: 30 }, (_, i) => `f${String(i)}.ts`);

  expect(filterFiles(many, "")).toHaveLength(8); // a dropdown, not a whole-tree dump
  expect(filterFiles(many, "")).toEqual(many.slice(0, 8)); // preserves input order
});

test("filterFiles: substring match is case-insensitive over the whole path", () => {
  expect(filterFiles(FILES, "STATUS")).toEqual(["src/render/status-bar.ts"]);
  expect(filterFiles(FILES, "render")).toEqual(["src/render/status-bar.ts"]);
});

test("filterFiles: basename-prefix matches rank ahead of mid-path matches", () => {
  // "bar.ts" basename starts with "ba" (rank 0); "navbar.tsx" only contains it (rank 2)
  expect(filterFiles(FILES, "ba")[0]).toBe("bar.ts");
});

test("filterFiles: ties preserve caller order (recency), no alphabetical reshuffle", () => {
  expect(filterFiles(["z/app.ts", "a/api.ts"], "a")).toEqual([
    "z/app.ts",
    "a/api.ts",
  ]);
});

test("truncatePath: keeps the tail (filename) with a leading ellipsis when clipped", () => {
  expect(truncatePath("src/cli.ts", 40)).toBe("src/cli.ts"); // fits ⇒ unchanged
  expect(truncatePath("packages/core/src/render/status-bar.ts", 12)).toBe(
    "…atus-bar.ts" // exactly 12 cols: ellipsis + last 11 chars
  );
  expect(truncatePath("anything", 0)).toBe("");
});

test("formatCompletionRows: one truncated row per file; selected gutter; no wrap", () => {
  const items: IMentionItem[] = FILES.map((path) => ({ kind: "file", path }));
  const rows = formatCompletionRows(items, 1, 40, false);

  expect(rows).toHaveLength(FILES.length);
  expect(rows[1]?.startsWith("▸")).toBe(true); // selected row marked

  for (const r of rows) {
    expect(r.length).toBeLessThanOrEqual(40); // never wider than the terminal
  }

  expect(rows.join("\n")).not.toContain(String.fromCharCode(27)); // color off ⇒ no ANSI
});

test("filterMentionItems: identifier query surfaces symbol prefix matches ahead of files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-mention-"));

  try {
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
        },
        include: ["*.ts"],
      })
    );
    await writeFile(
      join(dir, "types.ts"),
      "export interface IThing {\n  value: number;\n}\n"
    );
    await writeFile(
      join(dir, "use.ts"),
      'import type { IThing } from "./types";\nexport const f = (t: IThing): number => t.value;\n'
    );

    const svc = new TsService(dir);
    const items = filterMentionItems(
      ["src/types.ts", "src/use.ts"],
      "ITh",
      svc.symbols("ITh"),
      (abs) => abs.replace(`${dir}/`, "")
    );

    expect(items[0]?.kind).toBe("symbol");

    if (items[0]?.kind === "symbol") {
      expect(items[0].name).toBe("IThing");
      expect(items[0].file).toContain("types.ts");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("filterMentionItems: path query stays file-only even when symbols are supplied", () => {
  const symbols = [
    {
      name: "IThing",
      kind: "interface",
      file: "/tmp/types.ts",
      line: 1,
    },
  ];

  expect(
    filterMentionItems(["src/types.ts", "src/use.ts"], "src/", symbols)
  ).toEqual([
    { kind: "file", path: "src/types.ts" },
    { kind: "file", path: "src/use.ts" },
  ]);
});

test("formatCompletionRows: symbol rows show kind, name, and file:line", () => {
  const items: IMentionItem[] = [
    {
      kind: "symbol",
      name: "IThing",
      symbolKind: "interface",
      file: "src/types.ts",
      line: 3,
    },
  ];
  const rows = formatCompletionRows(items, 0, 60, false);

  expect(rows[0]).toContain("interface");
  expect(rows[0]).toContain("IThing");
  expect(rows[0]).toContain("types.ts:3");
});

test("mentionInsertText: file path vs symbol file:line anchor", () => {
  expect(mentionInsertText({ kind: "file", path: "src/a.ts" })).toBe(
    "src/a.ts"
  );
  expect(
    mentionInsertText({
      kind: "symbol",
      name: "IThing",
      symbolKind: "interface",
      file: "src/types.ts",
      line: 3,
    })
  ).toBe("src/types.ts:3");
});

test("formatCompletionRows: empty list still shows a 'no matching file' row", () => {
  const rows = formatCompletionRows([], 0, 40, false);

  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("no matching file");
});

test("shouldOpenAtPicker: fires at line start and after whitespace", () => {
  expect(shouldOpenAtPicker("@", 1)).toBe(true);
  expect(shouldOpenAtPicker("fix @", 5)).toBe(true);
});

test("shouldOpenAtPicker: does NOT fire inside a word (email / mid-token)", () => {
  expect(shouldOpenAtPicker("ag@", 3)).toBe(false);
  expect(shouldOpenAtPicker("foo@", 4)).toBe(false);
});

test("shouldOpenAtPicker: false when the char before the cursor is not @", () => {
  expect(shouldOpenAtPicker("@x", 2)).toBe(false);
});
