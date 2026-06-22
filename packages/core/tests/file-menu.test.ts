import { test, expect } from "bun:test";
import {
  filterFiles,
  formatCompletionRows,
  truncatePath,
  shouldOpenAtPicker,
} from "../src/render/file-menu";

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
  const rows = formatCompletionRows(FILES, 1, 40, false);

  expect(rows).toHaveLength(FILES.length);
  expect(rows[1]?.startsWith("›")).toBe(true); // selected row marked

  for (const r of rows) {
    expect(r.length).toBeLessThanOrEqual(40); // never wider than the terminal
  }

  expect(rows.join("\n")).not.toContain(String.fromCharCode(27)); // color off ⇒ no ANSI
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
