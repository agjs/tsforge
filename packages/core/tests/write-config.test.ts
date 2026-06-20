import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeSetupConfig, writeSetupConfig } from "../src/setup/write-config";
import type { IScanReport } from "../src/infer-rules/scan.types";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "tsforge-wc-"));
}

describe("mergeSetupConfig (pure)", () => {
  test("preserves unrelated fields, overrides setup-managed ones", () => {
    const existing = {
      mcpServers: { x: { command: "y" } },
      plugins: ["p"],
      policy: { mode: "ci" },
      stack: "react",
      conventions: { interfaces: "i-prefix" },
    };

    const merged = mergeSetupConfig(existing, {
      conventions: { interfaces: "bare-pascal-case", enums: "allow" },
      profile: "strict",
    });

    expect(merged.mcpServers).toEqual({ x: { command: "y" } });
    expect(merged.plugins).toEqual(["p"]);
    expect(merged.policy).toEqual({ mode: "ci" });
    expect(merged.stack).toBe("react");
    expect(merged.profile).toBe("strict");
    expect(merged.conventions).toEqual({
      interfaces: "bare-pascal-case",
      enums: "allow",
    });
  });

  test("leaves setup-managed fields untouched when not provided", () => {
    const merged = mergeSetupConfig({ profile: "security" }, {});

    expect(merged.profile).toBe("security");
  });
});

describe("writeSetupConfig (IO)", () => {
  test("creates config + evidence atomically, preserving existing keys", async () => {
    const dir = tmp();

    try {
      writeFileSync(
        join(dir, "tsforge.config.json"),
        JSON.stringify({ plugins: ["keep-me"] })
      );

      const result = await writeSetupConfig(
        dir,
        { conventions: { interfaces: "bare-pascal-case" } },
        undefined
      );

      expect(result.ok).toBe(true);

      const written = JSON.parse(
        await Bun.file(join(dir, "tsforge.config.json")).text()
      );

      expect(written.plugins).toEqual(["keep-me"]);
      expect(written.conventions).toEqual({ interfaces: "bare-pascal-case" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writes evidence file when a report is given", async () => {
    const dir = tmp();

    try {
      const report: IScanReport = {
        stack: { name: "x", packs: [], confidence: "guess", reason: "r" },
        interfaces: {
          iPrefixed: 0,
          bare: 0,
          total: 0,
          iExamples: [],
          bareExamples: [],
        },
        enums: { fileCount: 0 },
        tests: { coLocated: 0, mirrored: 0 },
        folders: {
          views: false,
          features: false,
          flatComponents: false,
          routeFolders: false,
        },
        tooling: { tsconfig: false, eslint: false, prettier: false },
        filesScanned: 0,
      };

      const result = await writeSetupConfig(dir, { profile: "strict" }, report);

      expect(result.ok).toBe(true);
      expect(existsSync(join(dir, ".tsforge/setup-evidence.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to clobber invalid existing JSON by default", async () => {
    const dir = tmp();

    try {
      writeFileSync(join(dir, "tsforge.config.json"), "{ broken json ");

      const result = await writeSetupConfig(
        dir,
        { conventions: { enums: "allow" } },
        undefined
      );

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.reason).toBe("invalid-existing-json");
      }

      // The broken file is untouched.
      expect(await Bun.file(join(dir, "tsforge.config.json")).text()).toBe(
        "{ broken json "
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("overwriteInvalid replaces a broken config", async () => {
    const dir = tmp();

    try {
      writeFileSync(join(dir, "tsforge.config.json"), "{ broken ");

      const result = await writeSetupConfig(
        dir,
        { conventions: { enums: "allow" } },
        undefined,
        { overwriteInvalid: true }
      );

      expect(result.ok).toBe(true);

      const written = JSON.parse(
        await Bun.file(join(dir, "tsforge.config.json")).text()
      );

      expect(written.conventions).toEqual({ enums: "allow" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
