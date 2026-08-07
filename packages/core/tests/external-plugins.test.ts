import { test, expect, describe, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  parsePlugins,
  isRulePack,
  loadExternalPacks,
  loadAndRegisterPlugins,
  freezeRulePack,
} from "../src/config/external-plugins";
import { fingerprintPluginEntry } from "../src/config/plugin-fingerprint";
import { createRule } from "../src/rule-packs/create-rule";
import {
  assertExternalPacksFrozen,
  buildPackEslintConfig,
  clearExternalPacks,
} from "../src/rule-packs";
import { ExternalPackDriftError } from "../src/rule-packs/drift-error";

const FIXTURE = join(import.meta.dir, "fixtures", "external-pack.ts");

/** Smallest valid pack — enough to register and fingerprint. */
const MINIMAL_PACK = `export const pack = {
  id: "gone-pack",
  description: "d",
  rules: {},
  rulesConfig: {},
};
`;

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

  test("a plugin deleted mid-session fails the freeze check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-gone-"));
    const entry = join(dir, "plugin.ts");

    await writeFile(entry, MINIMAL_PACK);
    await loadAndRegisterPlugins(
      [{ path: entry, packs: ["pack"] }],
      dir,
      () => undefined
    );
    await rm(entry);

    // Re-verification that cannot be performed is a drift, not a pass: an
    // unreadable entry must never resolve to "unchanged".
    await expect(assertExternalPacksFrozen()).rejects.toThrow(
      ExternalPackDriftError
    );
  });

  test("freezeRulePack freezes each rule module so create cannot be swapped", () => {
    const rule = createRule<[], "noFoo">({
      name: "no-foo",
      meta: {
        type: "problem",
        docs: { description: "d" },
        schema: [],
        messages: { noFoo: "no foo" },
      },
      defaultOptions: [],
      create: () => ({}),
    });
    const frozen = freezeRulePack({
      id: "x",
      description: "d",
      rules: { r: rule },
      rulesConfig: { r: "error" },
    });

    // A plugin keeping a reference to its own exported rule must not be able to
    // neuter it after registration — the disk never changes, so the fingerprint
    // cannot catch this one. Freezing the key set alone leaves `create` writable.
    expect(Object.isFrozen(frozen.rules.r)).toBe(true);
    expect(() => {
      rule.create = () => ({});
    }).toThrow(TypeError);
  });
});

describe("plugin-fingerprint: unpinnable content fails closed (F19)", () => {
  test("an unreadable entry throws instead of returning a digest over nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-missing-"));

    // Reachable in normal use: a config path without an extension resolves to a
    // path `import` can load but `readFile` cannot. A digest over zero files is
    // a constant, so every such plugin would share it and never register drift.
    await expect(fingerprintPluginEntry(join(dir, "nope.ts"))).rejects.toThrow(
      /cannot fingerprint/
    );
  });

  test("an import graph past the freeze cap throws instead of hashing a prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-huge-"));
    const deps: string[] = [];

    for (let i = 0; i < 80; i += 1) {
      const name = `dep${String(i)}`;

      deps.push(name);
      await writeFile(join(dir, `${name}.ts`), `export const n = 1;\n`);
    }

    await writeFile(
      join(dir, "index.ts"),
      `${deps.map((d) => `export { n as n_${d} } from "./${d}";`).join("\n")}\n`
    );

    // Silent truncation would fingerprint an arbitrary prefix of the graph, so
    // every edit past the cut would pass the freeze.
    await expect(fingerprintPluginEntry(join(dir, "index.ts"))).rejects.toThrow(
      /exceeds the freeze limit/
    );
  });

  test("a side-effect import is part of the frozen graph", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-sidefx-"));
    const dep = join(dir, "dep.ts");
    const entry = join(dir, "index.ts");

    await writeFile(dep, "globalThis.installed = 1;\n");
    // `import "./dep"` binds no names, so a specifier scan keyed on `from` misses
    // it — yet the file runs, and rule behavior can live entirely inside it.
    await writeFile(entry, `import "./dep";\nexport const v = 1;\n`);

    const before = await fingerprintPluginEntry(entry);

    await writeFile(dep, "globalThis.installed = 2;\n");

    expect(await fingerprintPluginEntry(entry)).not.toBe(before);
  });

  test("a symlinked entry fingerprints the real dependency graph", async () => {
    const real = await mkdtemp(join(tmpdir(), "tsforge-plugin-real-"));
    const link = await mkdtemp(join(tmpdir(), "tsforge-plugin-link-"));
    const dep = join(real, "dep.ts");
    const entry = join(link, "plugin.ts");

    await writeFile(dep, "export const n = 1;\n");
    await writeFile(
      join(real, "plugin.ts"),
      `import { n } from "./dep";\nexport const v = n;\n`
    );
    await symlink(join(real, "plugin.ts"), entry);

    const before = await fingerprintPluginEntry(entry);

    // Node resolves the plugin's relative imports against the REAL directory; a
    // lexical walk misses the whole graph and silently pins the entry alone.
    await writeFile(dep, "export const n = 2;\n");

    expect(await fingerprintPluginEntry(entry)).not.toBe(before);
  });

  test("a plugin that rewrites itself during import is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-toctou-"));
    const entry = join(dir, "plugin.ts");
    const messages: string[] = [];

    // Content swapped between fingerprint and import executes while the stored
    // digest describes bytes that were never loaded.
    await writeFile(
      entry,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(entry)}, "export const pack = { id: 'toctou', description: 'swapped', rules: {}, rulesConfig: {} };\\n");
export const pack = { id: "toctou", description: "original", rules: {}, rulesConfig: {} };
`
    );

    const packs = await loadExternalPacks([{ path: entry }], dir, (m) =>
      messages.push(m)
    );

    expect(packs).toHaveLength(0);
    expect(messages.some((m) => m.includes("changed while loading"))).toBe(
      true
    );
  });
});
