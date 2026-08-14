import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGate } from "../src/cli/gate-setup";
import { parseArgs } from "../src/cli";

/**
 * The structure rules are off by default so tsforge stays adoptable in an
 * existing repo with its own valid layout. A greenfield build has no such layout
 * to respect, and the silent default cost a real run: the convention guide
 * described folder-per-component while the gate accepted flat files.
 */
describe("greenfield picks the opinionated profile", () => {
  test("an empty dir enforces the structure rules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-gf-empty-"));

    try {
      const gate = await resolveGate({ ...parseArgs([]), dir }, null);

      expect(gate.accept).toContain('"component-folder-structure":"error"');
      expect(gate.accept).toContain('"one-component-per-file":"error"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("an existing project keeps them off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-gf-existing-"));

    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", dependencies: { react: "19.0.0" } })
      );

      const gate = await resolveGate({ ...parseArgs([]), dir }, null);

      // tsforge must not impose its tree on a repo that already has one.
      expect(gate.accept).toContain('"component-folder-structure":"off"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("an explicit profile still wins over the greenfield default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-gf-flag-"));

    try {
      const gate = await resolveGate(
        { ...parseArgs(["--profile", "recommended"]), dir },
        null
      );

      expect(gate.accept).toContain('"component-folder-structure":"off"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a configured profile still wins over the greenfield default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-gf-config-"));

    try {
      await writeFile(
        join(dir, "tsforge.config.json"),
        JSON.stringify({ profile: "recommended" })
      );

      const gate = await resolveGate({ ...parseArgs([]), dir }, null);

      expect(gate.accept).toContain('"component-folder-structure":"off"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
