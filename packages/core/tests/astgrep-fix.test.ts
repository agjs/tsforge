import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  astGrepFix,
  dropRedundantAnnotations,
  stripLiteralCasts,
} from "../src/loop/astgrep-fix";

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

test("drops redundant const annotations on call/expression initializers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-ag-"));
  const file = join(dir, "a.ts");

  try {
    await Bun.write(
      file,
      [
        "const abs: number = Math.abs(cents);",
        "const negative: boolean = cents < 0;",
        "const total: number = xs.reduce((acc, r) => acc + r, 0);",
      ].join("\n")
    );

    const dropped = await dropRedundantAnnotations(file);
    const out = await Bun.file(file).text();

    expect(dropped).toBe(3);
    expect(out).toContain("const abs = Math.abs(cents)");
    expect(out).toContain("const negative = cents < 0");
    expect(out).not.toContain(": number");
    expect(out).not.toContain(": boolean");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("strips needless literal-to-union casts but keeps `as const` and value casts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-ag-"));
  const file = join(dir, "a.ts");

  try {
    const src = [
      "const SIZES = ['s', 'm'] as const;",
      "const rows = [",
      "  { status: 'open' as Status, count: 200 as Code, flag: true as Bool },",
      "];",
      "const real = (x as Foo).bar;",
      "const keep = 'x' as const;",
    ].join("\n");

    await Bun.write(file, `${src}\n`);

    const stripped = await stripLiteralCasts(file);
    const out = await Bun.file(file).text();

    expect(stripped).toBe(3); // the three literal casts in the row
    expect(out).toContain("status: 'open'");
    expect(out).toContain("count: 200");
    expect(out).toContain("flag: true");
    // value cast (operand is an identifier) and both `as const` are untouched
    expect(out).toContain("(x as Foo).bar");
    expect(out).toContain("['s', 'm'] as const");
    expect(out).toContain("'x' as const");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps annotations whose drop would change the inferred type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-ag-"));
  const file = join(dir, "a.ts");

  try {
    // Each of these would infer a DIFFERENT type if the annotation were dropped:
    // `[]`→never[], `{}`→{}, null→null, arrow→implicit-any params under strict.
    const src = [
      "const result: number[] = [];",
      "const cfg: Record<string, number> = {};",
      "const node: INode | null = null;",
      "const fn: (n: number) => number = (n) => n + 1;",
    ].join("\n");

    await Bun.write(file, `${src}\n`);

    const dropped = await dropRedundantAnnotations(file);

    expect(dropped).toBe(0);
    expect(await Bun.file(file).text()).toBe(`${src}\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
