import { test, expect } from "bun:test";
import { renderEditor } from "../src/editor/view";

test("two unwrapped lines return exact row count", () => {
  const r = renderEditor(
    { lines: ["hello", "world"], cursorLine: 0, cursorCol: 0 },
    { columns: 40, maxRows: 6, color: false }
  );

  expect(r.rows).toBe(2);
  expect(r.frame).toContain("hello");
  expect(r.frame).toContain("world");
});

test("cursor on second unwrapped line has correct coordinates", () => {
  const r = renderEditor(
    { lines: ["hello", "world"], cursorLine: 1, cursorCol: 3 },
    { columns: 40, maxRows: 6, color: false }
  );

  expect(r.rows).toBe(2);
  expect(r.cursorRow).toBe(1);
  expect(r.cursorCol).toBe(3);
});

test("wrapped line computes rows and cursor position correctly", () => {
  const long = "x".repeat(50);
  const r = renderEditor(
    { lines: [long], cursorLine: 0, cursorCol: 50 },
    { columns: 20, maxRows: 6, color: false }
  );

  expect(r.rows).toBe(3);
  expect(r.cursorRow).toBe(2);
  expect(r.cursorCol).toBe(10);
});

test("empty buffer returns zero rows", () => {
  const r = renderEditor(
    { lines: [], cursorLine: 0, cursorCol: 0 },
    { columns: 40, maxRows: 6, color: false }
  );

  expect(r.rows).toBe(0);
  expect(r.cursorRow).toBe(0);
  expect(r.cursorCol).toBe(0);
  expect(r.frame).toBe("");
});

test("tall buffer clips with indicator and cursor in valid range", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const r = renderEditor(
    { lines, cursorLine: 19, cursorCol: 0 },
    { columns: 40, maxRows: 6, color: false }
  );

  expect(r.rows).toBeLessThanOrEqual(6);
  expect(r.frame).toContain("more");
  expect(r.cursorRow).toBeGreaterThanOrEqual(0);
  expect(r.cursorRow).toBeLessThan(r.rows);
});

test("single line renders one row", () => {
  const r = renderEditor(
    { lines: ["hello"], cursorLine: 0, cursorCol: 5 },
    { columns: 40, maxRows: 6, color: false }
  );

  expect(r.rows).toBe(1);
  expect(r.frame).toContain("hello");
  expect(r.cursorRow).toBe(0);
});

// region: Gemini PR #52 regression tests

test("emoji wrap and cursor positioning is grapheme-correct", () => {
  // Emoji 👍 is 1 grapheme, multiple UTF-16 units, and 2 terminal cells.
  // "hello 👍" fills 8 cells, so "world" starts on the next row.
  const line = "hello 👍world";
  const r = renderEditor(
    { lines: [line], cursorLine: 0, cursorCol: 7 }, // cursor at start of "world"
    { columns: 8, maxRows: 6, color: false }
  );

  // The line should wrap into 2 rows
  expect(r.rows).toBe(2);
  expect(r.cursorRow).toBe(1); // cursor is on second visual row
  expect(r.cursorCol).toBe(0); // at column 0 of the second row
});

test("CJK wide characters wrap by terminal cells, not grapheme count", () => {
  const r = renderEditor(
    { lines: ["abc日本d"], cursorLine: 0, cursorCol: 5 },
    { columns: 6, maxRows: 6, color: false }
  );

  expect(r.rows).toBe(2);
  expect(r.frame.split("\n")[0]).toBe("abc日");
  expect(r.cursorRow).toBe(1);
  expect(r.cursorCol).toBe(2);
});

test("one wrapped logical line taller than the editor is visually clipped", () => {
  const r = renderEditor(
    { lines: ["x".repeat(200)], cursorLine: 0, cursorCol: 200 },
    { columns: 20, maxRows: 7, color: false }
  );

  expect(r.rows).toBeLessThanOrEqual(7);
  expect(r.frame.split("\n")).toHaveLength(r.rows);
  expect(r.cursorRow).toBeGreaterThanOrEqual(0);
  expect(r.cursorRow).toBeLessThan(r.rows);
  expect(r.frame).toContain("more");
});

test("over-tall wrapped line keeps a top cursor in range when clipped below", () => {
  const r = renderEditor(
    { lines: ["x".repeat(200)], cursorLine: 0, cursorCol: 0 },
    { columns: 20, maxRows: 7, color: false }
  );

  expect(r.cursorRow).toBe(0);
  expect(r.frame).toContain("more");
});
