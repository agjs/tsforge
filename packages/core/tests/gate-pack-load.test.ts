import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackEslintConfig } from "../src/rule-packs";
import { resolveActivePacks } from "../src/config/tsforge-config";

const STRICT_CONFIG = join(import.meta.dir, "..", "strict.eslint.config.mjs");
const WEB_CONFIG = join(import.meta.dir, "..", "strict.web.eslint.config.mjs");

/** A pack id that resolves through Object.prototype, not through the registry. */
const PROTOTYPE_IDS = ["constructor", "toString", "valueOf"] as const;

let fixtureDir: string;
let pluginPath: string;

/** An external rule pack, shaped exactly as a `plugins` entry would export it. */
const PLUGIN_SOURCE = `export const housePack = {
  id: "house-external-pack",
  description: "fixture pack",
  rules: {
    "no-fixture": {
      meta: { type: "problem", schema: [], messages: { bad: "bad" } },
      create: () => ({}),
    },
  },
  rulesConfig: { "no-fixture": "error" },
};
`;

interface ILoadResult {
  exitCode: number;
  stderr: string;
  ruleCount: number;
}

/**
 * Load a bundled gate config in a FRESH process (as the spawned gate does) and
 * report how many `tsforge/*` rules it ended up with. Loading the config in-process
 * would not exercise the real path: the spawned gate has an empty external-pack
 * registry, which is precisely where packs used to vanish.
 */
async function loadGateConfig(
  configPath: string,
  env: Record<string, string>
): Promise<ILoadResult> {
  const script = `const cfg = (await import(${JSON.stringify(configPath)})).default;
const n = cfg.flatMap((b) => Object.keys(b?.rules ?? {})).filter((r) => r.startsWith("tsforge/")).length;
console.log("RULES=" + String(n));`;

  const proc = Bun.spawn(["bun", "-e", script], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    cwd: fixtureDir,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const match = /RULES=(\d+)/u.exec(stdout);

  return {
    exitCode,
    stderr,
    ruleCount: match?.[1] === undefined ? -1 : Number(match[1]),
  };
}

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "tsforge-pack-load-"));
  pluginPath = join(fixtureDir, "house-pack.mjs");
  writeFileSync(pluginPath, PLUGIN_SOURCE);
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("the gate never silently runs without its rule packs", () => {
  test("valid pack ids load their rules", async () => {
    const r = await loadGateConfig(STRICT_CONFIG, {
      TSFORGE_PACKS: "react,drizzle",
    });

    expect(r.exitCode).toBe(0);
    expect(r.ruleCount).toBeGreaterThan(0);
  });

  test("an unknown pack id fails the config load instead of dropping every pack", async () => {
    const r = await loadGateConfig(STRICT_CONFIG, {
      TSFORGE_PACKS: "react,drizzle,typo-pack",
    });

    // Fail CLOSED: a gate that cannot load its rules must not run as though it
    // had none. Silently continuing produced a green gate with zero pack rules.
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("typo-pack");
  });

  test("the web config fails closed on an unknown pack id too", async () => {
    const r = await loadGateConfig(WEB_CONFIG, {
      TSFORGE_PACKS: "react,typo-pack",
    });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("typo-pack");
  });

  test("external plugin packs resolve in the spawned gate", async () => {
    const r = await loadGateConfig(STRICT_CONFIG, {
      TSFORGE_PACKS: "react,drizzle,house-external-pack",
      TSFORGE_PLUGINS: JSON.stringify([{ path: pluginPath }]),
    });

    expect(r.exitCode).toBe(0);
    // The built-in packs' rules AND the plugin's rule are all present.
    expect(r.ruleCount).toBeGreaterThan(0);
    const withoutPlugin = await loadGateConfig(STRICT_CONFIG, {
      TSFORGE_PACKS: "react,drizzle",
    });

    expect(r.ruleCount).toBe(withoutPlugin.ruleCount + 1);
  });
});

describe("registry lookups reject prototype keys", () => {
  test("buildPackEslintConfig rejects a prototype key like any unknown id", () => {
    for (const id of PROTOTYPE_IDS) {
      // Previously `id in RULE_PACKS` was true for these, so lookupPack returned
      // Object.prototype.constructor and the builder died on `Object.entries(undefined)`.
      expect(() => buildPackEslintConfig([id])).toThrow(
        `Unknown rule pack: ${id}`
      );
    }
  });

  test("resolveActivePacks warns for a prototype key like any unknown id", () => {
    // warnConfig writes to stderr, so capture there rather than on console.
    const warnings: string[] = [];
    const original = process.stderr.write.bind(process.stderr);

    process.stderr.write = (chunk: unknown): boolean => {
      warnings.push(String(chunk));

      return true;
    };

    try {
      for (const id of [...PROTOTYPE_IDS, "not-a-pack"]) {
        resolveActivePacks([], { packs: { include: [id] } });
      }
    } finally {
      process.stderr.write = original;
    }

    // The control proves the warning path works at all; the prototype keys are
    // the ids that used to slip past it via the `in` operator.
    for (const id of [...PROTOTYPE_IDS, "not-a-pack"]) {
      expect(warnings.some((w) => w.includes(id))).toBe(true);
    }
  });
});
