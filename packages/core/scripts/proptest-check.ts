// Gate-runnable PROPERTY-TEST oracle: derive fast-check arbitraries from each
// exported function's TypeScript parameter types and assert it does NOT throw on
// valid typed input. Catches the crashes example tests miss — unguarded index
// access, NaN/empty-input math, bad coercions — using the types the function
// already declares (so the inputs are always valid, never garbage).
//
// OPT-IN: wired into the gate only when TSFORGE_PROPTEST=1. Skips cleanly (exit 0)
// when there's no tsconfig, no fuzzable function, or fast-check isn't installed.
// Best for pure functions; it only targets exports whose every parameter is a
// plain data type (primitives / arrays / records / unions of those), which
// naturally excludes most IO-bound functions.
//
//   TSFORGE_PROPTEST=1 bun proptest-check.ts
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import ts from "typescript";
import {
  propertyTargets,
  renderPropertyFile,
  propTestPath,
} from "../src/proptest/discover";

/** Build a Program from the project's tsconfig (or a permissive default). */
function buildProgram(cwd: string): ts.Program | null {
  const configPath = join(cwd, "tsconfig.json");

  if (!existsSync(configPath)) {
    return null;
  }

  const read = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, cwd);

  if (parsed.fileNames.length === 0) {
    return null;
  }

  return ts.createProgram(parsed.fileNames, parsed.options);
}

/** Absolute path to the harness's fast-check (it ships the dep; the TARGET
 *  project usually doesn't), or null when it can't be resolved. Baked into the
 *  generated test's import so the suite is self-contained in any project. */
function fastCheckPath(): string | null {
  try {
    return fileURLToPath(import.meta.resolve("fast-check"));
  } catch {
    return null;
  }
}

async function runGeneratedSuite(testFile: string): Promise<number> {
  const proc = Bun.spawn(["bun", "test", testFile], {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });

  await proc.exited;

  return proc.exitCode ?? -1;
}

async function main(): Promise<number> {
  const cwd = process.cwd();
  const program = buildProgram(cwd);

  if (program === null) {
    process.stdout.write("proptest-check: no tsconfig/sources — skipping.\n");

    return 0;
  }

  const fcPath = fastCheckPath();

  if (fcPath === null) {
    process.stdout.write(
      "proptest-check: fast-check not resolvable — skipping (install it to enable).\n"
    );

    return 0;
  }

  const targets = propertyTargets(program, program.getTypeChecker());

  if (targets.length === 0) {
    process.stdout.write(
      "proptest-check: no fuzzable exported functions found — skipping.\n"
    );

    return 0;
  }

  const testFile = propTestPath(cwd);

  mkdirSync(dirname(testFile), { recursive: true });
  writeFileSync(testFile, renderPropertyFile(targets, testFile, fcPath));

  try {
    const code = await runGeneratedSuite(testFile);

    if (code !== 0) {
      process.stderr.write(
        `proptest-check: a generated property test FAILED — a function throws on some valid typed input (${targets.length} function(s) fuzzed). Guard the offending input.\n`
      );

      return 1;
    }

    process.stdout.write(
      `proptest-check: ${targets.length} function(s) survived property fuzzing. OK\n`
    );

    return 0;
  } finally {
    rmSync(dirname(testFile), { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(await main());
}
