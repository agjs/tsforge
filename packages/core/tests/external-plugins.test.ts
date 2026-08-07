import { test, expect, describe, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  parsePlugins,
  isRulePack,
  loadExternalPacks,
  loadAndRegisterPlugins,
  freezeRulePack,
} from "../src/config/external-plugins";
import {
  FREEZE_LIMITS,
  fingerprintPluginEntry,
} from "../src/config/plugin-fingerprint";
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

  test("a rulesConfig whose severities change between reads is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-getter-"));
    const entry = join(dir, "plugin.ts");
    const messages: string[] = [];

    // Validation reads `rulesConfig` once and the freeze copies it again. A
    // getter that answers "error" to the validator and something else to the
    // copy registers a pack weaker than the one that was checked — and the
    // content fingerprint sees nothing, because the file never changes.
    await writeFile(
      entry,
      `let reads = 0;
export const pack = {
  id: "getter-pack",
  description: "d",
  rules: {},
  rulesConfig: {
    get "no-foo"() {
      reads += 1;
      return reads === 1 ? "error" : "off";
    },
  },
};
`
    );

    const loaded = await loadExternalPacks(
      [{ path: entry, packs: ["pack"] }],
      dir,
      (m) => messages.push(m)
    );

    expect(loaded).toHaveLength(0);
  });

  test("a plugin that fails leaves no partially registered packs behind", async () => {
    // The registry is global. Registering the good pack and only then throwing
    // leaves the run's rule set half-applied under an error that says the load
    // failed — a caller that catches it proceeds with packs nobody verified.
    await expect(
      loadAndRegisterPlugins(
        [
          { path: FIXTURE, packs: ["examplePack"] },
          { path: "./does-not-exist.ts" },
        ],
        import.meta.dir,
        () => undefined
      )
    ).rejects.toThrow(/does-not-exist/);

    expect(() => buildPackEslintConfig(["example-external"])).toThrow();
  });

  test("a configured plugin that yields no pack fails the run", async () => {
    // Skipping it leaves the run with FEWER rules than the config asks for, and
    // the only trace is one report line: a silently weaker gate is the failure
    // mode the freeze exists to prevent, arrived at from the other direction.
    await expect(
      loadAndRegisterPlugins(
        [{ path: "./does-not-exist.ts" }],
        import.meta.dir,
        () => undefined
      )
    ).rejects.toThrow(/does-not-exist/);
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

  test("freezeRulePack freezes a rule's meta, not just its top level", () => {
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

    // `meta` carries the reportable messages and the option schema — rewriting a
    // message or widening the schema changes what the rule enforces just as much
    // as swapping `create`, and a one-level freeze leaves all of it writable.
    expect(Object.isFrozen(frozen.rules.r?.meta)).toBe(true);
    expect(Object.isFrozen(frozen.rules.r?.meta.messages)).toBe(true);
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

    for (let i = 0; i < FREEZE_LIMITS.maxFiles + 8; i += 1) {
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

  test("a graph that exactly fills the cap still fingerprints", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-atcap-"));
    const deps: string[] = [];

    // `maxFiles - 1` deps plus the entry fill the file limit exactly. Each
    // extensionless specifier also queues 16 spellings, 15 of which do not
    // exist, so a cap check that asks "is the queue empty" throws on a graph
    // that fits.
    for (let i = 0; i < FREEZE_LIMITS.maxFiles - 1; i += 1) {
      const name = `dep${String(i)}`;

      deps.push(name);
      await writeFile(join(dir, `${name}.ts`), `export const n = 1;\n`);
    }

    await writeFile(
      join(dir, "index.ts"),
      `${deps.map((d) => `export { n as n_${d} } from "./${d}";`).join("\n")}\n`
    );

    expect(await fingerprintPluginEntry(join(dir, "index.ts"))).toHaveLength(
      64
    );
  });

  test("a relative import above the entry's directory is part of the graph", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-parent-"));
    const shared = join(dir, "shared.ts");
    const entry = join(dir, "plugins", "pack.ts");

    await mkdir(join(dir, "plugins"));
    await writeFile(shared, "export const severity = 'error';\n");
    await writeFile(
      entry,
      `import { severity } from "../shared";\nexport const v = severity;\n`
    );

    const before = await fingerprintPluginEntry(entry);

    // `../shared.ts` is executed by the plugin and is as editable as the entry;
    // skipping it because it sits above the entry's directory leaves the part of
    // the plugin most likely to hold shared rule config outside the freeze.
    await writeFile(shared, "export const severity = 'warn';\n");

    expect(await fingerprintPluginEntry(entry)).not.toBe(before);
  });

  test("a bare import that resolves to workspace source is part of the graph", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-linked-"));
    const pkg = join(dir, "pkg");
    const entry = join(dir, "plugin.ts");

    await mkdir(join(dir, "node_modules"), { recursive: true });
    await mkdir(pkg);
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "linkedpkg", version: "1.0.0", main: "index.ts" })
    );
    await writeFile(
      join(pkg, "index.ts"),
      "export const severity = 'error';\n"
    );
    await symlink(pkg, join(dir, "node_modules", "linkedpkg"));
    await writeFile(
      entry,
      `import { severity } from "linkedpkg";\nexport const v = severity;\n`
    );

    const before = await fingerprintPluginEntry(entry);

    // A linked workspace package (or a tsconfig path alias) is imported by name
    // but lives in the repo and is as editable as the plugin itself. Walking
    // only relative specifiers leaves that code executing outside the freeze.
    await writeFile(join(pkg, "index.ts"), "export const severity = 'warn';\n");

    expect(await fingerprintPluginEntry(entry)).not.toBe(before);
  });

  test("a real dependency under node_modules is not walked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-dep-"));
    const dep = join(dir, "node_modules", "realdep");
    const entry = join(dir, "plugin.ts");

    await mkdir(dep, { recursive: true });
    await writeFile(
      join(dep, "package.json"),
      JSON.stringify({ name: "realdep", version: "1.0.0", main: "index.ts" })
    );
    await writeFile(join(dep, "index.ts"), "export const n = 1;\n");
    await writeFile(
      entry,
      `import { n } from "realdep";\nexport const v = n;\n`
    );

    const before = await fingerprintPluginEntry(entry);

    // Installed packages are not the workspace-editable surface this freezes,
    // and hashing a dependency tree would put the walk in node_modules.
    await writeFile(join(dep, "index.ts"), "export const n = 2;\n");

    expect(await fingerprintPluginEntry(entry)).toBe(before);
  });

  test("an imported data file is part of the frozen graph", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-json-"));
    const data = join(dir, "severities.json");
    const entry = join(dir, "plugin.ts");

    await writeFile(data, `{ "no-foo": "error" }\n`);
    await writeFile(
      entry,
      `import severities from "./severities.json";\nexport const v = severities;\n`
    );

    const before = await fingerprintPluginEntry(entry);

    // A rule pack that reads its severities from an imported JSON file changes
    // what it enforces when that file changes. `.json` is not a code extension,
    // so a walk that only speculates code spellings drops it from the graph
    // entirely — the plugin's own config, editable and unpinned.
    await writeFile(data, `{ "no-foo": "warn" }\n`);

    expect(await fingerprintPluginEntry(entry)).not.toBe(before);
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

  test("a second load of changed content in one process is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-recache-"));
    const entry = join(dir, "plugin.ts");
    const pack = (description: string): string =>
      `export const pack = { id: "recache", description: "${description}", rules: {}, rulesConfig: {} };\n`;

    await writeFile(entry, pack("strong"));
    await loadAndRegisterPlugins(
      [{ path: entry, packs: ["pack"] }],
      dir,
      () => undefined
    );
    clearExternalPacks();

    await writeFile(entry, pack("weak"));

    // ESM caches by resolved URL and Bun ignores query strings, so a reload
    // returns the OLD module while the fingerprint pins the NEW bytes. Silently
    // registering that pair gives a pack whose rules and whose freeze describe
    // different content — undetectable afterwards, so refuse it here.
    const messages: string[] = [];
    const loaded = await loadExternalPacks(
      [{ path: entry, packs: ["pack"] }],
      dir,
      (m) => messages.push(m)
    );

    expect(loaded).toHaveLength(0);
    expect(messages.some((m) => m.includes("restart the session"))).toBe(true);
  });

  test("a bare-specifier plugin is loaded from the file that was pinned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-plugin-bare-"));
    const pkg = join(dir, "node_modules", "barepack");

    await mkdir(pkg, { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "barepack", version: "1.0.0", main: "index.ts" })
    );
    await writeFile(
      join(pkg, "index.ts"),
      `export const pack = { id: "bare", description: "d", rules: {}, rulesConfig: {} };\n`
    );

    // The fingerprint pins the file `Bun.resolveSync` picks; importing the raw
    // specifier instead re-resolves from this module's own directory and under
    // the runtime's export conditions, which can select a different file than
    // the one that was pinned.
    const [loaded] = await loadExternalPacks(
      [{ path: "barepack", packs: ["pack"] }],
      dir,
      () => undefined
    );

    expect(loaded?.pack.id).toBe("bare");
    expect(loaded?.entryPath).toBe(join(pkg, "index.ts"));
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
