import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { astGrepFix } from "../src/loop/astgrep-fix";

test("rewrites new Array().fill() to Array.from() (structural, ignores strings)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-ag-"));
  const file = join(dir, "a.ts");

  try {
    await Bun.write(
      file,
      [
        "const a = new Array(n).fill(0);",
        'const note = "new Array(x).fill(y) stays a string";',
      ].join("\n")
    );

    const applied = await astGrepFix(file);
    const out = await Bun.file(file).text();

    expect(applied).toBe(1);
    expect(out).toContain("Array.from({ length: n }, () => 0)");
    // The string literal must be untouched — the regex-based detector couldn't
    // guarantee this; ast-grep's structural matching does.
    expect(out).toContain('"new Array(x).fill(y) stays a string"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no-ops (returns 0) when there's nothing to rewrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-ag-"));
  const file = join(dir, "a.ts");

  try {
    await Bun.write(
      file,
      "export const x = Array.from({ length: 3 }, () => 0);\n"
    );

    expect(await astGrepFix(file)).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
