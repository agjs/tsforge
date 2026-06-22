import { test, expect } from "bun:test";
import {
  filterFiles,
  renderFileMenu,
  shouldOpenAtPicker,
} from "../src/render/file-menu";

const FILES = [
  "src/cli.ts",
  "src/render/status-bar.ts",
  "components/navbar.tsx",
  "bar.ts",
  "README.md",
];

test("filterFiles: empty query returns all (capped to a screenful)", () => {
  expect(filterFiles(FILES, "")).toEqual(FILES.slice(0, 50));

  const many = Array.from({ length: 60 }, (_, i) => `f${String(i)}.ts`);

  expect(filterFiles(many, "")).toHaveLength(50);
});

test("filterFiles: substring match is case-insensitive over the whole path", () => {
  expect(filterFiles(FILES, "STATUS")).toEqual(["src/render/status-bar.ts"]);
  expect(filterFiles(FILES, "render")).toEqual(["src/render/status-bar.ts"]);
});

test("filterFiles: basename-prefix matches rank ahead of mid-path matches", () => {
  // "bar.ts" basename starts with "ba" (rank 0); "navbar.tsx" only contains it (rank 2)
  expect(filterFiles(FILES, "ba")[0]).toBe("bar.ts");
});

test("renderFileMenu: marks the selected row; header echoes the @query", () => {
  const items = filterFiles(FILES, "");
  const out = renderFileMenu(items, 2, "", false);
  const lines = out.split("\n");

  expect(lines).toHaveLength(items.length + 1); // header + one row per file
  expect(lines[0]?.startsWith("@")).toBe(true);
  expect(lines[3]?.startsWith("›")).toBe(true); // selected index 2 → row line 3
  expect(out).toContain("src/cli.ts");
  expect(out).not.toContain(String.fromCharCode(27)); // color=false ⇒ no ANSI
});

test("renderFileMenu: empty result shows a 'no matching file' line", () => {
  expect(renderFileMenu([], 0, "zzz", false)).toContain("no matching file");
});

test("shouldOpenAtPicker: fires at line start and after whitespace", () => {
  expect(shouldOpenAtPicker("@", 1)).toBe(true);
  expect(shouldOpenAtPicker("fix @", 5)).toBe(true);
});

test("shouldOpenAtPicker: does NOT fire inside a word (email / mid-token)", () => {
  expect(shouldOpenAtPicker("ag@", 3)).toBe(false); // email-like, no boundary
  expect(shouldOpenAtPicker("foo@", 4)).toBe(false);
});

test("shouldOpenAtPicker: false when the char before the cursor is not @", () => {
  expect(shouldOpenAtPicker("@x", 2)).toBe(false); // cursor sits after a typed char
});
