import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  wireFeatureSetupSource,
  wireGameConfigSource,
  wireSlice,
} from "../src/loop/phaser/wire";
import type { Exec } from "../src/loop/phaser/exec";
import type { ISlice } from "../src/loop/planning/plan-types";
import type { IPhaserViewIntent } from "../src/loop/phaser/plan-extension";

const FIXTURES = join(import.meta.dir, "fixtures", "phaser-wire");

const silentExec: Exec = () =>
  Promise.resolve({ code: 0, stdout: "", stderr: "" });

describe("wireGameConfigSource", () => {
  test("appends a scene once and is idempotent", async () => {
    const src = await readFile(join(FIXTURES, "gameConfig.ts"), "utf8");
    const once = wireGameConfigSource(src, "ShopScene");

    expect(once).toContain("import { ShopScene }");
    expect(once).toContain("scene: [BootScene, WorldScene, ShopScene]");

    const twice = wireGameConfigSource(once, "ShopScene");

    expect(twice).toBe(once);
  });
});

describe("wireFeatureSetupSource", () => {
  test("inserts createCoinFeature and dispose once", async () => {
    const src = await readFile(join(FIXTURES, "WorldScene.setup.ts"), "utf8");
    const once = wireFeatureSetupSource(src, "Coin", "coin");

    expect(once).toContain("createCoinFeature");
    expect(once).toContain("const coin = createCoinFeature({ events })");
    expect(once).toContain("coin.dispose()");

    const twice = wireFeatureSetupSource(once, "Coin", "coin");

    expect(twice).toBe(once);
  });
});

describe("wireSlice", () => {
  test("wires a feature into WorldScene.setup.ts on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-phaser-wire-"));
    const rel = "src/runtime/phaser/scenes/WorldScene/WorldScene.setup.ts";
    const full = join(dir, rel);

    try {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(
        full,
        await readFile(join(FIXTURES, "WorldScene.setup.ts"), "utf8")
      );

      const slice: ISlice<IPhaserViewIntent> = {
        entity: {
          id: "Coin",
          desc: "a coin",
          fields: [],
          relationships: [],
          rules: [],
        },
        ui: { kind: "feature", scene: "World", feature: "coin" },
        verification: {
          mustRemainTrue: ["a"],
          mustNotHappen: ["b"],
          acceptanceCheck: "bun test",
        },
      };

      const result = await wireSlice(dir, slice, silentExec);
      const next = await readFile(full, "utf8");

      expect(result.paths).toContain(rel);
      expect(next).toContain("createCoinFeature");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails loud when the setup file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-phaser-wire-"));
    const slice: ISlice<IPhaserViewIntent> = {
      entity: {
        id: "Coin",
        desc: "a coin",
        fields: [],
        relationships: [],
        rules: [],
      },
      ui: { kind: "feature", scene: "World", feature: "coin" },
      verification: {
        mustRemainTrue: ["a"],
        mustNotHappen: ["b"],
        acceptanceCheck: "bun test",
      },
    };

    try {
      await expect(wireSlice(dir, slice, silentExec)).rejects.toThrow(
        /missing .*WorldScene\.setup\.ts/u
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
