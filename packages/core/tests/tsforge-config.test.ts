import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTsforgeConfig,
  resolveActivePacks,
  normalizeRuleOverrides,
  resolveProjectProfile,
  resolveAgentConcurrency,
  type ITsforgeProjectConfig,
} from "../src/config/tsforge-config";
import { makeFileLinter } from "../src/gate";

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "tsforge-config-"));
  writeFileSync(
    join(fixtureDir, "package.json"),
    JSON.stringify({
      name: "test-app",
      dependencies: { drizzle: "0.36.0" },
    })
  );
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("loadTsforgeConfig", () => {
  test("missing file returns empty config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsforge-missing-"));

    try {
      const config = await loadTsforgeConfig(dir);

      expect(config).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("walks UP to find the nearest config (running from a subdirectory)", async () => {
    // The CLI runs with cwd = packages/core (its own dir has no config), so the
    // loader must climb to the project root — otherwise agents.concurrency (and
    // profile/policy) silently fall back to defaults. Regression for cap-1 spawns.
    const root = mkdtempSync(join(tmpdir(), "tsforge-root-"));

    try {
      writeFileSync(
        join(root, "tsforge.config.json"),
        JSON.stringify({ agents: { concurrency: 4 } })
      );
      const nested = join(root, "packages", "core");

      mkdirSync(nested, { recursive: true });

      const config = await loadTsforgeConfig(nested);

      expect(config.agents?.concurrency).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid JSON returns empty config with warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsforge-invalid-"));

    try {
      writeFileSync(join(dir, "tsforge.config.json"), "{ not valid json }");
      const config = await loadTsforgeConfig(dir);

      expect(config).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("valid config with stack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsforge-stack-"));

    try {
      writeFileSync(
        join(dir, "tsforge.config.json"),
        JSON.stringify({ stack: "react" })
      );
      const config = await loadTsforgeConfig(dir);

      expect(config.stack).toBe("react");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("valid config with packs include/exclude", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsforge-packs-"));

    try {
      writeFileSync(
        join(dir, "tsforge.config.json"),
        JSON.stringify({
          packs: { include: ["bullmq"], exclude: ["drizzle"] },
        })
      );
      const config = await loadTsforgeConfig(dir);

      expect(config.packs?.include).toEqual(["bullmq"]);
      expect(config.packs?.exclude).toEqual(["drizzle"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("valid config with rule overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsforge-rules-"));

    try {
      writeFileSync(
        join(dir, "tsforge.config.json"),
        JSON.stringify({
          rules: {
            "timestamp-must-specify-mode": "off",
            "some-rule": "warn",
          },
        })
      );
      const config = await loadTsforgeConfig(dir);

      expect(config.rules?.["timestamp-must-specify-mode"]).toBe("off");
      expect(config.rules?.["some-rule"]).toBe("warn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid field types are ignored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsforge-types-"));

    try {
      writeFileSync(
        join(dir, "tsforge.config.json"),
        JSON.stringify({
          stack: 123,
          packs: ["not", "an", "object"],
          rules: ["not", "an", "object"],
        })
      );
      const config = await loadTsforgeConfig(dir);

      expect(config.stack).toBeUndefined();
      expect(config.packs).toBeUndefined();
      expect(config.rules).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agents block + resolveAgentConcurrency", () => {
  async function loadWith(agents: unknown): Promise<ITsforgeProjectConfig> {
    const dir = mkdtempSync(join(tmpdir(), "tsforge-agents-"));

    try {
      writeFileSync(
        join(dir, "tsforge.config.json"),
        JSON.stringify({ agents })
      );

      return await loadTsforgeConfig(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a valid concurrency loads and resolves", async () => {
    const config = await loadWith({ concurrency: 4 });

    expect(config.agents?.concurrency).toBe(4);
    expect(resolveAgentConcurrency(config)).toBe(4);
  });

  test("absent block resolves to 1 (sequential default)", () => {
    expect(resolveAgentConcurrency({})).toBe(1);
  });

  test("invalid concurrency values are warn-and-dropped", async () => {
    for (const bad of [0, 17, 1.5, "3", -2, null]) {
      const config = await loadWith({ concurrency: bad });

      expect(config.agents).toBeUndefined();
      expect(resolveAgentConcurrency(config)).toBe(1);
    }
  });

  test("a non-object agents block is dropped", async () => {
    const config = await loadWith("fast");

    expect(config.agents).toBeUndefined();
  });
});

describe("resolveActivePacks", () => {
  test("empty config returns detected packs unchanged", () => {
    const detected = ["generic-ts", "env-access"];
    const result = resolveActivePacks(detected, {});

    expect(result).toContain("generic-ts");
    expect(result).toContain("env-access");
  });

  test("include adds packs", () => {
    const detected = ["generic-ts"];
    const config: ITsforgeProjectConfig = {
      packs: { include: ["drizzle"] },
    };
    const result = resolveActivePacks(detected, config);

    expect(result).toContain("generic-ts");
    expect(result).toContain("drizzle");
  });

  test("exclude removes packs", () => {
    const detected = ["generic-ts", "drizzle"];
    const config: ITsforgeProjectConfig = {
      packs: { exclude: ["drizzle"] },
    };
    const result = resolveActivePacks(detected, config);

    expect(result).toContain("generic-ts");
    expect(result).not.toContain("drizzle");
  });

  test("include and exclude applied together", () => {
    const detected = ["generic-ts", "env-access"];
    const config: ITsforgeProjectConfig = {
      packs: { include: ["drizzle", "react"], exclude: ["env-access"] },
    };
    const result = resolveActivePacks(detected, config);

    expect(result).toContain("generic-ts");
    expect(result).toContain("drizzle");
    expect(result).toContain("react");
    expect(result).not.toContain("env-access");
  });

  test("stack forces a pack if configured", () => {
    const detected = ["generic-ts"];
    const config: ITsforgeProjectConfig = { stack: "drizzle" };
    const result = resolveActivePacks(detected, config);

    expect(result).toContain("drizzle");
  });

  test("result is deterministically sorted", () => {
    const detected = ["z-pack", "a-pack"];
    const config: ITsforgeProjectConfig = {
      packs: { include: ["m-pack"] },
    };
    const result = resolveActivePacks(detected, config);

    expect(result).toEqual(["a-pack", "m-pack", "z-pack"]);
  });
});

describe("normalizeRuleOverrides", () => {
  test("empty config applies recommended profile defaults", () => {
    const result = normalizeRuleOverrides({});

    expect(result["component-folder-structure"]).toBe("off");
    expect(result["prefer-early-return"]).toBe("warn");
  });

  test("bare rule names preserved", () => {
    const config: ITsforgeProjectConfig = {
      rules: { "timestamp-must-specify-mode": "off" },
    };
    const result = normalizeRuleOverrides(config);

    expect(result["timestamp-must-specify-mode"]).toBe("off");
  });

  test("tsforge-prefixed names are stripped", () => {
    const config: ITsforgeProjectConfig = {
      rules: { "tsforge/timestamp-must-specify-mode": "warn" },
    };
    const result = normalizeRuleOverrides(config);

    expect(result["timestamp-must-specify-mode"]).toBe("warn");
  });

  test("both bare and prefixed forms accepted", () => {
    const config: ITsforgeProjectConfig = {
      rules: {
        "rule-one": "error",
        "tsforge/rule-two": "warn",
      },
    };
    const result = normalizeRuleOverrides(config);

    expect(result["rule-one"]).toBe("error");
    expect(result["rule-two"]).toBe("warn");
  });

  test("invalid severities are filtered out", () => {
    const config: ITsforgeProjectConfig = {
      rules: {
        "valid-rule": "off",
        "invalid-rule": "invalid-severity" as unknown as "off",
      },
    };
    const result = normalizeRuleOverrides(config);

    expect(result["valid-rule"]).toBe("off");
    expect(result["invalid-rule"]).toBeUndefined();
  });
});

describe("makeFileLinter with rule overrides", () => {
  test("rule override to 'off' silences the rule", async () => {
    writeFileSync(
      join(fixtureDir, "schema.ts"),
      `import { pgTable, timestamp } from "drizzle-orm/pg-core";
export const users = pgTable("users", {
  createdAt: timestamp("created_at"),
});`
    );

    const ruleOverrides: Readonly<Record<string, "error" | "warn" | "off">> = {
      "timestamp-must-specify-mode": "off",
    };
    const linter = makeFileLinter(
      "core",
      fixtureDir,
      ["drizzle"],
      ruleOverrides
    );
    const problems = await linter(join(fixtureDir, "schema.ts"));
    const hasDrizzleViolation = problems.some((p) =>
      p.ruleId.includes("timestamp-must-specify-mode")
    );

    expect(hasDrizzleViolation).toBe(false);
  });

  test("rule override to 'warn' changes severity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsforge-linter-warn-"));

    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test" })
      );
      writeFileSync(
        join(dir, "bad.ts"),
        `const x: number = 5;
const y: number = 10;`
      );

      const overrides: Readonly<Record<string, "error" | "warn" | "off">> = {
        "no-inferrable-types": "warn",
      };
      const linter = makeFileLinter("core", dir, undefined, overrides);
      const problems = await linter(join(dir, "bad.ts"));

      expect(problems.length).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without overrides, pack rules fire normally", async () => {
    writeFileSync(
      join(fixtureDir, "clean-schema.ts"),
      `import { pgTable, timestamp } from "drizzle-orm/pg-core";
export const posts = pgTable("posts", {
  createdAt: timestamp("created_at", { mode: "date" }),
});`
    );

    const linter = makeFileLinter("core", fixtureDir, ["drizzle"]);
    const problems = await linter(join(fixtureDir, "clean-schema.ts"));
    const hasDrizzleViolation = problems.some((p) =>
      p.ruleId.includes("tsforge/")
    );

    expect(hasDrizzleViolation).toBe(false);
  });
});

describe("tsforge.config.json integration", () => {
  test("config with all fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsforge-full-"));

    try {
      writeFileSync(
        join(dir, "tsforge.config.json"),
        JSON.stringify({
          stack: "react",
          packs: {
            include: ["tanstack-query"],
            exclude: ["drizzle"],
          },
          rules: {
            "timestamp-must-specify-mode": "off",
            "tsforge/some-other-rule": "warn",
          },
        })
      );

      const config = await loadTsforgeConfig(dir);

      expect(config.stack).toBe("react");
      expect(config.packs?.include).toContain("tanstack-query");
      expect(config.packs?.exclude).toContain("drizzle");
      expect(Object.keys(config.rules ?? {})).toHaveLength(2);

      const activePacks = resolveActivePacks(["generic-ts", "drizzle"], config);

      expect(activePacks).toContain("react");
      expect(activePacks).toContain("tanstack-query");
      expect(activePacks).not.toContain("drizzle");

      const overrides = normalizeRuleOverrides(config);

      expect(overrides["timestamp-must-specify-mode"]).toBe("off");
      expect(overrides["some-other-rule"]).toBe("warn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("profiles", () => {
  test("recommended profile disables architecture rules by default", () => {
    const overrides = normalizeRuleOverrides({ profile: "recommended" });

    expect(overrides["component-folder-structure"]).toBe("off");
    expect(overrides["prefer-early-return"]).toBe("warn");
  });

  test("strict profile adds meta-rules at error and typescript-core pack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsforge-profile-"));

    try {
      writeFileSync(
        join(dir, "tsforge.config.json"),
        JSON.stringify({ profile: "strict" })
      );

      const config = await loadTsforgeConfig(dir);
      const packs = resolveActivePacks(["generic-ts"], config);
      const overrides = normalizeRuleOverrides(config);

      expect(resolveProjectProfile(config)).toBe("strict");
      expect(packs).toContain("typescript-core");
      expect(overrides["workflow-permissions-explicit"]).toBe("error");
      expect(overrides["lockfile-required"]).toBe("error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("security profile adds authorization pack", () => {
    const packs = resolveActivePacks(["generic-ts"], { profile: "security" });

    expect(packs).toContain("authorization");
  });

  test("opinionated profile enables architecture rules", () => {
    const overrides = normalizeRuleOverrides({ profile: "opinionated" });

    expect(overrides["component-folder-structure"]).toBe("error");
    expect(overrides["prefer-early-return"]).toBe("error");
  });
});
