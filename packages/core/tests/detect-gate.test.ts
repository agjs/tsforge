import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGate } from "../src/detect-gate";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsforge-gate-"));
}

test("greenfield TS project: brings a strict tsconfig + gates on tsc AND eslint", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const gate = await buildGate(dir);

    // type-aware floor + syntactic idioms
    expect(gate.command).toContain("--noEmit -p tsconfig.json");
    expect(gate.command).toContain("strict.eslint.config.mjs");
    expect(gate.label).toContain("tsc --strict");
    expect(gate.label).toContain("strict TypeScript");

    // it brought a strict tsconfig with the index-safety floor
    const tsconfig = await readFile(join(dir, "tsconfig.json"), "utf8");

    expect(tsconfig).toContain("noUncheckedIndexedAccess");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("respects the project's own lint script (but still runs tsc)", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } })
    );
    const gate = await buildGate(dir);

    expect(gate.command).toContain("run lint");
    expect(gate.label).toContain("project lint");
    expect(gate.command).toContain("--noEmit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("respects an existing tsconfig instead of overwriting it", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await writeFile(join(dir, "tsconfig.json"), '{ "mine": true }\n');
    await buildGate(dir);

    // untouched — we never clobber a project's own config
    expect(await readFile(join(dir, "tsconfig.json"), "utf8")).toContain(
      '"mine": true'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-TS directory (no package.json): eslint-only, no tsc, no tsconfig written", async () => {
  const dir = await tempDir();

  try {
    const gate = await buildGate(dir);

    expect(gate.command).toContain("strict.eslint.config.mjs");
    expect(gate.command).not.toContain("--noEmit");
    expect(await Bun.file(join(dir, "tsconfig.json")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
