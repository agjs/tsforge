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
