import { test, expect } from "bun:test";
import { renderEditor } from "../src/editor/view";

test("single line renders one row with the gutter", () => {
  const r = renderEditor(
    { lines: ["hello"], cursorLine: 0, cursorCol: 5 },
    { columns: 40, maxRows: 6, color: false }
  );

  expect(r.rows).toBe(1);
  expect(r.frame).toContain("hello");
  expect(r.cursorRow).toBe(0);
});

test("a long line wraps to multiple visual rows", () => {
  const long = "x".repeat(50);
  const r = renderEditor(
    { lines: [long], cursorLine: 0, cursorCol: 50 },
    { columns: 20, maxRows: 6, color: false }
  );

  expect(r.rows).toBeGreaterThan(1);
});

test("buffer taller than maxRows clips with a scroll indicator", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const r = renderEditor(
    { lines, cursorLine: 19, cursorCol: 0 },
    { columns: 40, maxRows: 6, color: false }
  );

  expect(r.rows).toBeLessThanOrEqual(6);
  expect(r.frame).toContain("more");
});
