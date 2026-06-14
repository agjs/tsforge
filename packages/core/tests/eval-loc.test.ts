import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countLoc, countTaskLoc } from "../src/eval/loc";

test("countLoc ignores blank and comment lines", () => {
  const code = `// header comment
export function add(a: number, b: number): number {

  return a + b; // trailing comment still counts the line
}
`;

  // 3 real lines: the signature, the return, the closing brace.
  expect(countLoc(code)).toBe(3);
});

test("countLoc strips block comments, including multi-line", () => {
  const code = `/* a
   multi-line
   block */
const x = 1;
/* inline */ const y = 2;
`;

  expect(countLoc(code)).toBe(2);
});

test("countLoc counts a verbose step-commented solution as more than a lean one", () => {
  const verbose = `// Step 1: lowercase
const lower = input.toLowerCase();
// Step 2: replace non-alphanumerics
const dashed = lower.replace(/[^a-z0-9]+/g, "-");
// Step 3: trim hyphens
const trimmed = dashed.replace(/^-+|-+$/g, "");
return trimmed;`;
  const lean = `return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");`;

  expect(countLoc(verbose)).toBeGreaterThan(countLoc(lean));
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tsforge-loc-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("countTaskLoc sums plain filenames and expands globs", async () => {
  writeFileSync(join(dir, "a.ts"), "const a = 1;\nconst b = 2;\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "b.ts"), "const c = 3;\n");

  const byName = await countTaskLoc(dir, ["a.ts"]);

  expect(byName.totalLoc).toBe(2);
  expect(byName.perFile["a.ts"]).toBe(2);

  const byGlob = await countTaskLoc(dir, ["**/*.ts"]);

  expect(byGlob.totalLoc).toBe(3);
});

test("countTaskLoc: a pattern matching nothing contributes 0", async () => {
  const result = await countTaskLoc(dir, ["does-not-exist.ts"]);

  expect(result.totalLoc).toBe(0);
  expect(Object.keys(result.perFile)).toHaveLength(0);
});
