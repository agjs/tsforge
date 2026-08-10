import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedReactGreenfieldOpinionated } from "../src/config/seed-greenfield-profile";
import { loadTsforgeConfig } from "../src/config/tsforge-config";

describe("seedReactGreenfieldOpinionated", () => {
  let dir = "";

  afterEach(async () => {
    if (dir.length > 0) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  test("empty dir does not seed (caller must be React-owned)", async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-seed-empty-"));
    const result = await seedReactGreenfieldOpinionated(dir);

    expect(result).toEqual({
      seeded: false,
      reason: "no react dependency",
    });
    expect(await Bun.file(join(dir, "tsforge.config.json")).exists()).toBe(
      false
    );
  });

  test("react package.json without profile seeds opinionated", async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-seed-react-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "app",
        dependencies: { react: "19.0.0" },
      })
    );

    expect((await seedReactGreenfieldOpinionated(dir)).seeded).toBe(true);
    expect((await loadTsforgeConfig(dir)).profile).toBe("opinionated");
  });

  test("does not overwrite an existing profile", async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-seed-keep-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "19.0.0" } })
    );
    await writeFile(
      join(dir, "tsforge.config.json"),
      JSON.stringify({ profile: "recommended", packs: { include: ["react"] } })
    );

    const result = await seedReactGreenfieldOpinionated(dir);

    expect(result).toEqual({
      seeded: false,
      reason: "profile already set",
    });
    expect((await loadTsforgeConfig(dir)).profile).toBe("recommended");
  });

  test("non-react package.json is left alone", async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-seed-node-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "cli", dependencies: { commander: "12.0.0" } })
    );

    const result = await seedReactGreenfieldOpinionated(dir);

    expect(result.seeded).toBe(false);
    expect(await Bun.file(join(dir, "tsforge.config.json")).exists()).toBe(
      false
    );
  });
});
