import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGate } from "../src/gate";

const ROOT = join(import.meta.dir, "..", "..", "..");
const TSC_BIN = join(ROOT, "node_modules", ".bin", "tsc");

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

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tsforge-incr-")));

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
  writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(dir, "src", "m.ts"), "export const n: number = 1;\n");

  return dir;
}

test("buildGate wires incremental tsc + a git-ignored buildinfo", async () => {
  const dir = project();

  try {
    const gate = await buildGate(dir, []);

    expect(gate.command).toContain("--incremental");
    expect(gate.command).toContain(
      "--tsBuildInfoFile .tsforge/gate.tsbuildinfo"
    );
    // The buildinfo is kept out of git via the scoped .tsforge/.gitignore.
    const ignore = readFileSync(join(dir, ".tsforge", ".gitignore"), "utf8");

    expect(ignore).toContain("gate.tsbuildinfo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildGate caches the syntactic eslint pass, dir made in-process + git-ignored", async () => {
  const dir = project();

  try {
    const gate = await buildGate(dir, []);

    // The syntactic strict pass caches results across repair cycles…
    expect(gate.command).toContain(
      '--cache --cache-location ".tsforge/eslint-gate.cache"'
    );
    // …the type-aware pass must NOT (editing one file changes another's errors).
    expect(gate.command).not.toContain("type-aware");
    // No shell `mkdir` in the command — the dir is created in-process (correct
    // cwd, cross-platform) before the gate runs.
    expect(gate.command).not.toContain("mkdir");
    expect(existsSync(join(dir, ".tsforge"))).toBe(true);
    // The cache file is git-ignored alongside the tsc buildinfo.
    const ignore = readFileSync(join(dir, ".tsforge", ".gitignore"), "utf8");

    expect(ignore).toContain("eslint-gate.cache");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildGate creates the cache dir even for a lint-only project (no tsconfig)", async () => {
  // tscPart returns null here, so the dir would otherwise never be made and the
  // eslint --cache-location write would fail with ENOENT.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tsforge-lintonly-")));

  try {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");

    const gate = await buildGate(dir, []);

    expect(gate.command).not.toContain("tsc");
    expect(gate.command).toContain("eslint-gate.cache");
    expect(existsSync(join(dir, ".tsforge"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// CORRECTNESS: a warm incremental run reusing the buildinfo must STILL fail when a
// type error is (re)introduced — proving incremental never serves a stale green.
test("incremental gate still catches a newly-introduced type error (no stale green)", async () => {
  const dir = project();

  const runTsc = async (): Promise<number> => {
    const proc = Bun.spawn(
      [
        "bun",
        TSC_BIN,
        "--noEmit",
        "--incremental",
        "--tsBuildInfoFile",
        ".tsforge/gate.tsbuildinfo",
        "-p",
        "tsconfig.json",
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" }
    );

    await proc.exited;

    return proc.exitCode ?? -1;
  };

  try {
    mkdirSync(join(dir, ".tsforge"), { recursive: true });

    // Cold: clean → passes, writes the buildinfo.
    expect(await runTsc()).toBe(0);
    expect(existsSync(join(dir, ".tsforge", "gate.tsbuildinfo"))).toBe(true);

    // Introduce a type error, then run WARM (same buildinfo on disk).
    writeFileSync(
      join(dir, "src", "m.ts"),
      'export const n: number = "nope";\n'
    );

    expect(await runTsc()).not.toBe(0);

    // Fix it again → warm run passes (buildinfo invalidated correctly).
    writeFileSync(join(dir, "src", "m.ts"), "export const n: number = 2;\n");

    expect(await runTsc()).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
