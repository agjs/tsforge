import { test, expect, describe } from "bun:test";

import { RULE_PACKS, buildPackEslintConfig } from "../src/rule-packs";

describe("rule-packs: registry", () => {
  test("should have all five packs registered", () => {
    expect(Object.keys(RULE_PACKS).sort()).toEqual([
      "code-flow",
      "comment-hygiene",
      "env-access",
      "module-boundaries",
      "test-conventions",
    ]);
  });

  test("each pack should have id, description, rules, and rulesConfig", () => {
    for (const [packId, pack] of Object.entries(RULE_PACKS)) {
      expect(pack.id).toBe(packId);
      expect(typeof pack.description).toBe("string");
      expect(pack.description.length).toBeGreaterThan(0);
      expect(typeof pack.rules).toBe("object");
      expect(Object.keys(pack.rules).length).toBeGreaterThan(0);
      expect(typeof pack.rulesConfig).toBe("object");
      expect(Object.keys(pack.rulesConfig).length).toBe(
        Object.keys(pack.rules).length
      );
    }
  });
});

describe("env-access pack", () => {
  test("should export envAccessPack with correct structure", () => {
    const pack = RULE_PACKS["env-access"];

    expect(pack.id).toBe("env-access");
    expect(pack.description).toContain("environment");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "no-direct-process-env",
      "no-process-exit",
    ]);
    expect(pack.rulesConfig["no-direct-process-env"]).toBe("error");
    expect(pack.rulesConfig["no-process-exit"]).toBe("error");
  });
});

describe("code-flow pack", () => {
  test("should export codeFlowPack with correct structure", () => {
    const pack = RULE_PACKS["code-flow"];

    expect(pack.id).toBe("code-flow");
    expect(pack.description).toContain("flow");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "no-bare-date-now",
      "no-template-trim-empty-ternary",
      "prefer-early-return",
    ]);
  });
});

describe("comment-hygiene pack", () => {
  test("should export commentHygienePack with correct structure", () => {
    const pack = RULE_PACKS["comment-hygiene"];

    expect(pack.id).toBe("comment-hygiene");
    expect(pack.description).toContain("comment");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "no-historical-comments",
      "no-narration-comments",
      "no-pr-reference-comments",
    ]);
  });
});

describe("test-conventions pack", () => {
  test("should export testConventionsPack with correct structure", () => {
    const pack = RULE_PACKS["test-conventions"];

    expect(pack.id).toBe("test-conventions");
    expect(pack.description).toContain("test");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "no-focused-tests",
      "test-file-mirrors-source",
    ]);
  });
});

describe("module-boundaries pack", () => {
  test("should export moduleBoundariesPack with correct structure", () => {
    const pack = RULE_PACKS["module-boundaries"];

    expect(pack.id).toBe("module-boundaries");
    expect(pack.description).toContain("module");
    expect(Object.keys(pack.rules)).toContain("single-semantic-module");
  });
});

describe("buildPackEslintConfig", () => {
  test("should merge rules from selected packs", () => {
    const { plugin, rules } = buildPackEslintConfig([
      "env-access",
      "code-flow",
    ]);

    expect(plugin.meta?.name).toBe("tsforge");
    const pluginRules = plugin.rules ?? {};

    expect(Object.keys(pluginRules).sort()).toEqual([
      "no-bare-date-now",
      "no-direct-process-env",
      "no-process-exit",
      "no-template-trim-empty-ternary",
      "prefer-early-return",
    ]);

    expect(Object.keys(rules).sort()).toEqual([
      "tsforge/no-bare-date-now",
      "tsforge/no-direct-process-env",
      "tsforge/no-process-exit",
      "tsforge/no-template-trim-empty-ternary",
      "tsforge/prefer-early-return",
    ]);
  });

  test("should throw on unknown pack ID", () => {
    expect(() => {
      buildPackEslintConfig(["unknown-pack" as any]);
    }).toThrow("Unknown rule pack");
  });

  test("should build config with all five packs without collision", () => {
    expect(() => {
      buildPackEslintConfig([
        "env-access",
        "code-flow",
        "comment-hygiene",
        "test-conventions",
        "module-boundaries",
      ]);
    }).not.toThrow();
  });

  test("should map rule names to severities with tsforge/ prefix", () => {
    const { rules } = buildPackEslintConfig(["env-access"]);

    expect(rules["tsforge/no-direct-process-env"]).toBe("error");
    expect(rules["tsforge/no-process-exit"]).toBe("error");
  });

  test("should include all rules from all packs when building full config", () => {
    const { rules } = buildPackEslintConfig([
      "env-access",
      "code-flow",
      "comment-hygiene",
      "test-conventions",
      "module-boundaries",
    ]);

    // env-access: 2 rules
    expect(rules["tsforge/no-direct-process-env"]).toBe("error");
    expect(rules["tsforge/no-process-exit"]).toBe("error");

    // code-flow: 3 rules
    expect(rules["tsforge/no-bare-date-now"]).toBe("error");
    expect(rules["tsforge/no-template-trim-empty-ternary"]).toBe("error");
    expect(rules["tsforge/prefer-early-return"]).toBe("error");

    // comment-hygiene: 3 rules
    expect(rules["tsforge/no-historical-comments"]).toBe("error");
    expect(rules["tsforge/no-narration-comments"]).toBe("error");
    expect(rules["tsforge/no-pr-reference-comments"]).toBe("error");

    // test-conventions: 2 rules
    expect(rules["tsforge/no-focused-tests"]).toBe("error");
    expect(rules["tsforge/test-file-mirrors-source"]).toBe("error");

    // module-boundaries: 1 rule
    expect(rules["tsforge/single-semantic-module"]).toBe("error");

    // Total: 11 rules
    expect(Object.keys(rules).length).toBe(11);
  });
});
