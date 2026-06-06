import { test, expect } from "bun:test";
import { renderFileSection, exportedSymbols } from "../src/loop/project-map";

test("exportedSymbols extracts declared + named exports", () => {
  const c =
    "export function foo() {}\nexport const bar = 1;\nexport interface IBaz {}\nexport { qux, a as b };\n";
  const ex = exportedSymbols(c);

  expect(ex).toContain("foo");
  expect(ex).toContain("bar");
  expect(ex).toContain("IBaz");
  expect(ex).toContain("qux");
  expect(ex).toContain("a"); // `a as b` → exported name is `a`
});

test("renderFileSection dumps full content when the project is small", () => {
  const r = renderFileSection([
    { path: "a.ts", content: "export const x = 1;\n" },
  ]);

  expect(r.mapped).toBe(false);
  expect(r.text).toContain("export const x = 1;");
});

test("renderFileSection switches to a MAP when content is large", () => {
  const big = `export const x = 1;\n${"// padding line\n".repeat(2000)}`; // >12k chars

  const r = renderFileSection([{ path: "big.ts", content: big }]);

  expect(r.mapped).toBe(true);
  expect(r.text).toContain("big.ts");
  expect(r.text).toContain("exports: x");
  expect(r.text).not.toContain("// padding line"); // full content NOT dumped
});
