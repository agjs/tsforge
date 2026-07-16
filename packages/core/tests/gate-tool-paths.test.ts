import { test, expect, describe } from "bun:test";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TSC_BIN, resolveTs7Tsc } from "../src/gate/tool-paths";

describe("TSC_BIN (resolveTs7Tsc)", () => {
  test("resolves the TypeScript 7 native compiler (@typescript/native)", () => {
    // Deterministic: the gate references TS7 by package path, not the ambiguous
    // .bin/tsc (both `typescript` and `@typescript/native` expose a `tsc` bin).
    expect(TSC_BIN).toContain("@typescript/native");
    expect(existsSync(TSC_BIN)).toBe(true);
  });

  test("the resolved binary is actually TypeScript 7", () => {
    // Prefix with `bun` so this works cross-platform (extensionless bin files
    // aren't directly executable on Windows).
    const out = spawnSync("bun", [TSC_BIN, "--version"], { encoding: "utf8" });

    expect(out.status).toBe(0);
    expect(out.stdout).toContain("Version 7.");
  });
});

describe("resolveTs7Tsc layout handling", () => {
  function withLayout(rel: string): { dir: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "ts7-layout-"));
    const binPath = join(root, rel);

    mkdirSync(join(binPath, ".."), { recursive: true });
    writeFileSync(binPath, "#!/bin/sh\n");

    return {
      dir: root,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  test("finds the hoisted (monorepo) layout: <dir>/node_modules/@typescript/native/bin/tsc", () => {
    const { dir, cleanup } = withLayout(
      "node_modules/@typescript/native/bin/tsc"
    );

    try {
      // start from a nested dir so the walk-up has to climb
      const start = join(dir, "packages", "core", "src", "gate");

      mkdirSync(start, { recursive: true });

      expect(resolveTs7Tsc(start)).toBe(
        join(dir, "node_modules/@typescript/native/bin/tsc")
      );
    } finally {
      cleanup();
    }
  });

  test("finds the published layout where the start dir is itself node_modules", () => {
    const { dir, cleanup } = withLayout(
      "node_modules/@typescript/native/bin/tsc"
    );

    try {
      // walk begins inside node_modules → the package is a DIRECT child
      const start = join(dir, "node_modules", "@agjs", "tsforge", "dist");

      mkdirSync(start, { recursive: true });

      expect(resolveTs7Tsc(start)).toBe(
        join(dir, "node_modules/@typescript/native/bin/tsc")
      );
    } finally {
      cleanup();
    }
  });

  test("falls back (and warns) when @typescript/native is absent", () => {
    const empty = mkdtempSync(join(tmpdir(), "ts7-none-"));

    try {
      // No @typescript/native anywhere under `empty` → fallback path (not a crash)
      const resolved = resolveTs7Tsc(empty);

      expect(resolved).not.toContain("@typescript/native");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
