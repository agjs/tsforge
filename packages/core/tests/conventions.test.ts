import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsforgeConfig } from "../src/config/tsforge-config";
import {
  DEFAULT_CONVENTIONS,
  isComponentFoldersConvention,
  isEnumConvention,
  isInterfaceConvention,
  isTestConvention,
  resolveConventions,
} from "../src/infer-rules/conventions";

async function withConfig<T>(
  body: unknown,
  fn: (dir: string) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "tsforge-conv-"));

  try {
    writeFileSync(join(dir, "tsforge.config.json"), JSON.stringify(body));

    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("conventions core", () => {
  test("defaults reproduce the current house style", () => {
    expect(DEFAULT_CONVENTIONS).toEqual({
      interfaces: "i-prefix",
      enums: "ban",
      tests: "either",
      componentFolders: "tsforge-views",
    });
  });

  test("resolveConventions fills unset fields from defaults", () => {
    expect(resolveConventions({ interfaces: "bare-pascal-case" })).toEqual({
      interfaces: "bare-pascal-case",
      enums: "ban",
      tests: "either",
      componentFolders: "tsforge-views",
    });
  });

  test("resolveConventions(undefined) is the full default set", () => {
    expect(resolveConventions(undefined)).toEqual(DEFAULT_CONVENTIONS);
  });

  test("guards accept valid values and reject junk", () => {
    expect(isInterfaceConvention("bare-pascal-case")).toBe(true);
    expect(isInterfaceConvention("nope")).toBe(false);
    expect(isEnumConvention("allow")).toBe(true);
    expect(isEnumConvention(42)).toBe(false);
    expect(isTestConvention("mirrored")).toBe(true);
    expect(isTestConvention("")).toBe(false);
    expect(isComponentFoldersConvention("repo")).toBe(true);
    expect(isComponentFoldersConvention(null)).toBe(false);
  });
});

describe("config: conventions field", () => {
  test("valid conventions block is loaded", async () => {
    const config = await withConfig(
      {
        conventions: {
          interfaces: "bare-pascal-case",
          enums: "allow",
          tests: "mirrored",
          componentFolders: "repo",
        },
      },
      (dir) => loadTsforgeConfig(dir)
    );

    expect(config.conventions).toEqual({
      interfaces: "bare-pascal-case",
      enums: "allow",
      tests: "mirrored",
      componentFolders: "repo",
    });
  });

  test("invalid sub-values are dropped, valid ones kept", async () => {
    const config = await withConfig(
      { conventions: { interfaces: "klingon", enums: "allow" } },
      (dir) => loadTsforgeConfig(dir)
    );

    expect(config.conventions).toEqual({ enums: "allow" });
  });

  test("a conventions block of only-invalid values becomes undefined", async () => {
    const config = await withConfig(
      { conventions: { interfaces: 7, tests: "weekly" } },
      (dir) => loadTsforgeConfig(dir)
    );

    expect(config.conventions).toBeUndefined();
  });

  test("non-object conventions is dropped", async () => {
    const config = await withConfig({ conventions: "i-prefix" }, (dir) =>
      loadTsforgeConfig(dir)
    );

    expect(config.conventions).toBeUndefined();
  });

  test("conventions is absent when not configured", async () => {
    const config = await withConfig({ stack: "react" }, (dir) =>
      loadTsforgeConfig(dir)
    );

    expect(config.conventions).toBeUndefined();
    expect(config.stack).toBe("react");
  });
});
