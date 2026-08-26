import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSlice, sliceOwnedPaths } from "../src/loop/phaser/generate";
import type { Exec } from "../src/loop/phaser/exec";
import type { ISlice } from "../src/loop/planning/plan-types";
import type { IPhaserViewIntent } from "../src/loop/phaser/plan-extension";

function featureSlice(): ISlice<IPhaserViewIntent> {
  return {
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
}

describe("generateSlice", () => {
  test("runs new:feature -- Coin and skips when the dir exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-phaser-gen-"));
    const calls: string[][] = [];

    const exec: Exec = (argv) => {
      calls.push([...argv]);

      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    try {
      const first = await generateSlice(dir, featureSlice(), exec);

      expect(first.skipped).toBe(false);
      expect(first.argv).toEqual(["bun", "run", "new:feature", "--", "Coin"]);
      expect(sliceOwnedPaths(featureSlice())).toContain(
        "src/features/coin/CoinFeature.ts"
      );

      await mkdir(join(dir, "src/features/coin"), { recursive: true });
      await writeFile(
        join(dir, "src/features/coin/CoinFeature.ts"),
        "export const edited = true;\n"
      );

      const second = await generateSlice(dir, featureSlice(), exec);

      expect(second.skipped).toBe(true);
      expect(second.argv).toBeNull();
      expect(calls).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("scene generate uses <Name>Scene", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-phaser-gen-"));
    const calls: string[][] = [];

    const exec: Exec = (argv) => {
      calls.push([...argv]);

      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    const slice: ISlice<IPhaserViewIntent> = {
      ...featureSlice(),
      entity: { ...featureSlice().entity, id: "Shop" },
      ui: { kind: "scene", scene: "Shop" },
    };

    try {
      await generateSlice(dir, slice, exec);
      expect(calls[0]).toEqual(["bun", "run", "new:scene", "--", "ShopScene"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
