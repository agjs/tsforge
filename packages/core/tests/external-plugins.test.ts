import { test, expect, describe, afterEach } from "bun:test";
import { join } from "node:path";
import {
  parsePlugins,
  isRulePack,
  loadExternalPacks,
  loadAndRegisterPlugins,
} from "../src/config/external-plugins";
import { buildPackEslintConfig, clearExternalPacks } from "../src/rule-packs";

const FIXTURE = join(import.meta.dir, "fixtures", "external-pack.ts");

afterEach(() => {
  clearExternalPacks();
});

describe("external-plugins: parsePlugins", () => {
  test("keeps valid entries and drops entries without a path", () => {
    const plugins = parsePlugins([
      { path: "./x", packs: ["a"] },
      { nope: 1 },
      { path: "" },
    ]);

    expect(plugins).toEqual([{ path: "./x", packs: ["a"] }]);
  });

  test("returns [] for a non-array", () => {
    expect(parsePlugins("nope")).toEqual([]);
  });
});

describe("external-plugins: isRulePack", () => {
  test("accepts a well-formed pack", () => {
    expect(
      isRulePack({ id: "x", description: "d", rules: {}, rulesConfig: {} })
    ).toBe(true);
  });

  test("rejects bad severity and missing fields", () => {
    expect(
      isRulePack({
        id: "x",
        description: "d",
        rules: {},
        rulesConfig: { r: "off" },
      })
    ).toBe(false);
    expect(isRulePack({ id: "x" })).toBe(false);
    expect(isRulePack(null)).toBe(false);
  });
});

describe("external-plugins: loading", () => {
  test("loads a valid pack from a fixture module", async () => {
    const packs = await loadExternalPacks(
      [{ path: FIXTURE, packs: ["examplePack"] }],
      import.meta.dir,
      () => undefined
    );

    expect(packs).toHaveLength(1);
    expect(packs[0]?.id).toBe("example-external");
  });

  test("a missing module is reported and skipped, not thrown", async () => {
    const messages: string[] = [];
    const packs = await loadExternalPacks(
      [{ path: "./does-not-exist.ts" }],
      import.meta.dir,
      (m) => messages.push(m)
    );

    expect(packs).toHaveLength(0);
    expect(messages.some((m) => m.includes("failed to load"))).toBe(true);
  });

  test("registering a plugin lets buildPackEslintConfig resolve its pack", async () => {
    const ids = await loadAndRegisterPlugins(
      [{ path: FIXTURE, packs: ["examplePack"] }],
      import.meta.dir,
      () => undefined
    );

    expect(ids).toContain("example-external");

    const { rules } = buildPackEslintConfig(["example-external"]);

    expect(Object.keys(rules)).toContain("tsforge/no-foo-identifier");
  });

  test("an external rule name colliding with a built-in fails the build", async () => {
    await loadAndRegisterPlugins(
      [{ path: FIXTURE, packs: ["collidingPack"] }],
      import.meta.dir,
      () => undefined
    );

    expect(() =>
      buildPackEslintConfig(["module-boundaries", "example-collision"])
    ).toThrow("collision");
  });
});
