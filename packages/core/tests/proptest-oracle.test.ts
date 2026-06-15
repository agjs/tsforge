import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { propertyTargets, renderPropertyFile } from "../src/proptest/discover";

const PROPTEST_SCRIPT = join(
  import.meta.dir,
  "..",
  "scripts",
  "proptest-check.ts"
);

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    skipLibCheck: true,
  },
  include: ["src"],
});

function fixture(source: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tsforge-pt-")));

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
  writeFileSync(join(dir, "src", "m.ts"), source);

  return dir;
}

function programFor(dir: string): ts.Program {
  const read = ts.readConfigFile(join(dir, "tsconfig.json"), (p) =>
    ts.sys.readFile(p)
  );
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dir);

  return ts.createProgram(parsed.fileNames, parsed.options);
}

test("propertyTargets finds modelable functions and skips the rest", () => {
  const dir = fixture(
    [
      "export function inc(n: number): number { return n + 1; }",
      "export function join2(a: string, b: string): string { return a + b; }",
      "export function withCallback(fn: () => void): void { fn(); }",
      "export function noArgs(): number { return 1; }",
    ].join("\n")
  );

  try {
    const program = programFor(dir);
    const targets = propertyTargets(program, program.getTypeChecker());
    const names = targets.map((t) => t.exportName).sort();

    expect(names).toEqual(["inc", "join2"]); // callback + 0-arg skipped
    const inc = targets.find((t) => t.exportName === "inc");

    expect(inc?.arbs).toEqual(["fc.double()"]);
    const j = targets.find((t) => t.exportName === "join2");

    expect(j?.arbs).toEqual(["fc.string()", "fc.string()"]);

    const rendered = renderPropertyFile(targets, join(dir, "gen.test.ts"));

    expect(rendered).toContain("fast-check");
    expect(rendered).toContain("fc.property");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function runOracle(dir: string): Promise<number> {
  const proc = Bun.spawn(["bun", PROPTEST_SCRIPT], {
    cwd: dir,
    env: { ...process.env, TSFORGE_PROPTEST: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.exited;

  return proc.exitCode ?? -1;
}

test("oracle FAILS on a function that throws for some valid typed input", async () => {
  // head([]) → xs[0] is undefined → .valueOf() throws. fast-check will find [].
  const dir = fixture(
    "export function head(xs: number[]): number { return xs[0].valueOf(); }\n"
  );

  try {
    expect(await runOracle(dir)).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oracle PASSES a total function", async () => {
  const dir = fixture(
    "export function inc(n: number): number { return n + 1; }\n"
  );

  try {
    expect(await runOracle(dir)).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
