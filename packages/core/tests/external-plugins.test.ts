import { test, expect, describe, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  parsePlugins,
  isRulePack,
  loadExternalPacks,
  loadAndRegisterPlugins,
  freezeRulePack,
} from "../src/config/external-plugins";
import { fingerprintPluginEntry } from "../src/config/plugin-fingerprint";
import {
  assertExternalPacksFrozen,
  buildPackEslintConfig,
  clearExternalPacks,
} from "../src/rule-packs";

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
    expect(packs[0]?.pack.id).toBe("example-external");
    expect(packs[0]?.fingerprint.length).toBe(64);
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

describe("external-plugins: content freeze (F19)", () => {
  test("freezeRulePack keeps a frozen rulesConfig copy", () => {
    const live: {
      id: string;
      description: string;
      rules: Record<string, never>;
      rulesConfig: Record<string, "error" | "warn">;
    } = {
      id: "x",
      description: "d",
      rules: {},
      rulesConfig: { "no-foo": "error" },
    };
    const frozen = freezeRulePack(live);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.rulesConfig)).toBe(true);
    // The original export can still be mutated — registration keeps its own freeze.
    live.rulesConfig["no-foo"] = "warn";
    expect(frozen.rulesConfig["no-foo"]).toBe("error");
  });

  test("fingerprint changes when a relative import's source is edited", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-fp-"));
    const entry = join(dir, "index.ts");
    const dep = join(dir, "dep.ts");

    await writeFile(dep, "export const n = 1;\n");
    await writeFile(
      entry,
      `import { n } from "./dep";\nexport const examplePack = { id: "p", description: "d", rules: {}, rulesConfig: {} };\nvoid n;\n`
    );

    const before = await fingerprintPluginEntry(entry);

    await writeFile(dep, "export const n = 2;\n");
    const after = await fingerprintPluginEntry(entry);

    expect(before).not.toBe(after);
    expect(before).toHaveLength(64);
  });

  test("a plugin edited mid-session fails the freeze check instead of weakening", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-drift-"));
    const entry = join(dir, "plugin.ts");

    // Minimal valid pack (no createRule) — enough to register + fingerprint.
    await writeFile(
      entry,
      `export const pack = {
  id: "drift-pack",
  description: "strong",
  rules: {},
  rulesConfig: { "no-bar": "error" },
};
`
    );

    const ids = await loadAndRegisterPlugins(
      [{ path: entry, packs: ["pack"] }],
      dir,
      () => undefined
    );

    expect(ids).toContain("drift-pack");
    await expect(assertExternalPacksFrozen()).resolves.toBeUndefined();

    // Weaken the on-disk plugin under the same pack id.
    await writeFile(
      entry,
      `export const pack = {
  id: "drift-pack",
  description: "weak",
  rules: {},
  rulesConfig: {},
};
`
    );

    await expect(assertExternalPacksFrozen()).rejects.toThrow(
      /changed on disk/
    );
  });
});
