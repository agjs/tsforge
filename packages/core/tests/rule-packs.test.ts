import { test, expect, describe } from "bun:test";
import { TSESLint } from "@typescript-eslint/utils";
import tsParser from "@typescript-eslint/parser";

import { RULE_PACKS, buildPackEslintConfig } from "../src/rule-packs";
import { setFileExistsForTesting } from "../src/rule-packs/test-conventions/rules/test-file-mirrors-source";

/**
 * Helper to lint code against a single rule from a pack.
 * Uses ESLint's Linter to run the rule in isolation with proper AST parsing.
 */
function lint(
  packId: keyof typeof RULE_PACKS,
  ruleName: string,
  code: string,
  filename = "src/example.ts",
  options?: unknown[]
) {
  const linter = new TSESLint.Linter();
  const pack = RULE_PACKS[packId];
  const rule = pack.rules[ruleName];

  if (!rule) {
    throw new Error(`Rule ${ruleName} not found in pack ${packId}`);
  }

  // TSESLint's own Linter is typed for the rule modules the packs hold, so the
  // rule goes in as-is — no cast to bridge, and no way to assert away a real
  // shape mismatch.
  const isTsx = filename.endsWith(".tsx");

  const config = {
    files: [isTsx ? "**/*.tsx" : "**/*.ts"],
    plugins: { tsforge: { rules: { [ruleName]: rule } } },
    rules: {
      [`tsforge/${ruleName}`]: options ? ["error", ...options] : "error",
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: isTsx ? { jsx: true } : undefined,
      },
    },
  } satisfies TSESLint.FlatConfig.Config;

  return linter.verify(code, config, filename);
}

describe("rule-packs: registry", () => {
  test("should have all twenty-one packs registered", () => {
    expect(Object.keys(RULE_PACKS).sort()).toEqual([
      "ai-sdk",
      "authorization",
      "bullmq",
      "code-flow",
      "comment-hygiene",
      "drizzle",
      "elysia",
      "env-access",
      "fastify",
      "i18n-keys",
      "jwt-cookies",
      "module-boundaries",
      "nextjs",
      "oauth-security",
      "react-component-architecture",
      "runtime-boundaries",
      "security",
      "structured-logging",
      "tanstack-query",
      "test-conventions",
      "typescript-core",
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

  test("no-direct-process-env: rule exists and is callable", () => {
    const rule = RULE_PACKS["env-access"].rules["no-direct-process-env"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("process.env");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("no-process-exit: rule exists and is callable", () => {
    const rule = RULE_PACKS["env-access"].rules["no-process-exit"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("process.exit");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
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
      "no-throw-literal",
      "prefer-early-return",
    ]);
  });

  test("no-bare-date-now: rule exists and is callable", () => {
    const rule = RULE_PACKS["code-flow"].rules["no-bare-date-now"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("Date.now");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("no-template-trim-empty-ternary: rule exists and is callable", () => {
    const rule =
      RULE_PACKS["code-flow"].rules["no-template-trim-empty-ternary"]!;

    expect(rule.meta.type).toBe("suggestion");
    expect(rule.meta.docs?.description).toContain("trim");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("prefer-early-return: rule exists and is callable", () => {
    const rule = RULE_PACKS["code-flow"].rules["prefer-early-return"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("guard clause");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
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

  test("no-historical-comments: rule exists and is callable", () => {
    const rule = RULE_PACKS["comment-hygiene"].rules["no-historical-comments"]!;

    expect(rule.meta.type).toBe("suggestion");
    expect(rule.meta.docs?.description).toContain("past");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("no-narration-comments: rule exists and is callable", () => {
    const rule = RULE_PACKS["comment-hygiene"].rules["no-narration-comments"]!;

    expect(rule.meta.type).toBe("suggestion");
    expect(rule.meta.docs?.description).toContain("narrative");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("no-pr-reference-comments: rule exists and is callable", () => {
    const rule =
      RULE_PACKS["comment-hygiene"].rules["no-pr-reference-comments"]!;

    expect(rule.meta.type).toBe("suggestion");
    expect(rule.meta.docs?.description).toContain("PR/issue");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });
});

describe("test-conventions pack", () => {
  test("should export testConventionsPack with correct structure", () => {
    const pack = RULE_PACKS["test-conventions"];

    expect(pack.id).toBe("test-conventions");
    expect(pack.description).toContain("test");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "fake-timers-must-be-restored",
      "no-conditional-expect",
      "no-focused-tests",
      "no-real-network-in-unit-tests",
      "test-file-mirrors-source",
    ]);
  });

  test("no-focused-tests: rule exists and is callable", () => {
    const rule = RULE_PACKS["test-conventions"].rules["no-focused-tests"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("focused");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("test-file-mirrors-source: rule exists and is callable", () => {
    const rule =
      RULE_PACKS["test-conventions"].rules["test-file-mirrors-source"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("test");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
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
      "no-throw-literal",
      "prefer-early-return",
    ]);

    expect(Object.keys(rules).sort()).toEqual([
      "tsforge/no-bare-date-now",
      "tsforge/no-direct-process-env",
      "tsforge/no-process-exit",
      "tsforge/no-template-trim-empty-ternary",
      "tsforge/no-throw-literal",
      "tsforge/prefer-early-return",
    ]);
  });

  test("should throw on unknown pack ID not in registry", () => {
    expect(() => {
      buildPackEslintConfig(["unknown-pack"]);
    }).toThrow("Unknown rule pack");
  });

  test("should skip pack IDs known to stack-detection but absent from RULE_PACKS", () => {
    // generic-ts is in PACK_REGISTRY but carries no eslint rules, so it should be skipped
    const { plugin, rules } = buildPackEslintConfig([
      "env-access",
      "generic-ts",
    ]);

    expect(plugin.meta?.name).toBe("tsforge");
    // Should only have env-access rules
    expect(Object.keys(rules).sort()).toEqual([
      "tsforge/no-direct-process-env",
      "tsforge/no-process-exit",
    ]);
  });

  test("should build config with all four packs without collision", () => {
    expect(() => {
      buildPackEslintConfig([
        "env-access",
        "code-flow",
        "comment-hygiene",
        "test-conventions",
      ]);
    }).not.toThrow();
  });

  test("elysia + fastify coexist without a rule-name collision", () => {
    // Both packs once defined a rule keyed `require-plugin-name`, so enabling
    // both (a monorepo with services in each framework) threw an uncaught
    // "Rule collision" that crashed the gate. The rules are now framework-scoped.
    expect(() => {
      buildPackEslintConfig(["elysia", "fastify"]);
    }).not.toThrow();

    const { rules } = buildPackEslintConfig(["elysia", "fastify"]);

    expect(rules["tsforge/require-elysia-plugin-name"]).toBe("error");
    expect(rules["tsforge/require-fastify-plugin-name"]).toBe("error");
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
    ]);

    // env-access: 2 rules
    expect(rules["tsforge/no-direct-process-env"]).toBe("error");
    expect(rules["tsforge/no-process-exit"]).toBe("error");

    // code-flow: 4 rules
    expect(rules["tsforge/no-bare-date-now"]).toBe("error");
    expect(rules["tsforge/no-template-trim-empty-ternary"]).toBe("error");
    expect(rules["tsforge/no-throw-literal"]).toBe("error");
    expect(rules["tsforge/prefer-early-return"]).toBe("warn");

    // comment-hygiene: 3 rules
    expect(rules["tsforge/no-historical-comments"]).toBe("error");
    expect(rules["tsforge/no-narration-comments"]).toBe("error");
    expect(rules["tsforge/no-pr-reference-comments"]).toBe("error");

    // test-conventions: 5 rules
    expect(rules["tsforge/fake-timers-must-be-restored"]).toBe("error");
    expect(rules["tsforge/no-conditional-expect"]).toBe("error");
    expect(rules["tsforge/no-focused-tests"]).toBe("error");
    expect(rules["tsforge/no-real-network-in-unit-tests"]).toBe("warn");
    expect(rules["tsforge/test-file-mirrors-source"]).toBe("error");

    // Total: 14 rules
    expect(Object.keys(rules).length).toBe(14);
  });
});

// ===== BEHAVIORAL TESTS: Every rule exercised against real code =====

describe("env-access: no-direct-process-env", () => {
  test("reports direct process.env property access", () => {
    const messages = lint(
      "env-access",
      "no-direct-process-env",
      "const port = process.env.PORT;",
      "src/api/server.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("directProcessEnv");
  });

  test("reports process.env destructuring", () => {
    const messages = lint(
      "env-access",
      "no-direct-process-env",
      "const { PORT, NODE_ENV } = process.env;",
      "src/services/config.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("directProcessEnv");
  });

  test("allows process.env in src/config/env/** allowlisted files", () => {
    const messages = lint(
      "env-access",
      "no-direct-process-env",
      "const port = process.env.PORT;",
      "src/config/env/index.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("allows process.env in scripts/** allowlisted files", () => {
    const messages = lint(
      "env-access",
      "no-direct-process-env",
      "const mode = process.env.MODE;",
      "scripts/setup.ts",
      [{ allowedFiles: ["scripts/**"] }]
    );

    expect(messages).toHaveLength(0);
  });

  test("allows imported env object", () => {
    const messages = lint(
      "env-access",
      "no-direct-process-env",
      "import { env } from '@/config/env'; const port = env.PORT;",
      "src/api/server.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("env-access: no-process-exit", () => {
  test("reports process.exit() in non-allowed files", () => {
    const messages = lint(
      "env-access",
      "no-process-exit",
      "process.exit(1);",
      "src/api/handler.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("processExit");
  });

  test("allows process.exit() in error-handlers", () => {
    const messages = lint(
      "env-access",
      "no-process-exit",
      "process.exit(1);",
      "src/config/error-handlers/graceful-shutdown.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("allows process.exit() in scripts", () => {
    const messages = lint(
      "env-access",
      "no-process-exit",
      "process.exit(0);",
      "scripts/migrate.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("allows process.on without process.exit", () => {
    const messages = lint(
      "env-access",
      "no-process-exit",
      "process.on('SIGTERM', () => {});",
      "src/app.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("code-flow: no-bare-date-now", () => {
  test("reports Date.now() call", () => {
    const messages = lint(
      "code-flow",
      "no-bare-date-now",
      "const timestamp = Date.now();",
      "src/utils/time.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("bareDateNow");
  });

  test("reports Math.random() call", () => {
    const messages = lint(
      "code-flow",
      "no-bare-date-now",
      "const id = Math.random();",
      "src/utils/id.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("bareMathRandom");
  });

  test("reports new Date() with no arguments", () => {
    const messages = lint(
      "code-flow",
      "no-bare-date-now",
      "const now = new Date();",
      "src/utils/time.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("bareNewDate");
  });

  test("allows Date.now() in allowlisted files", () => {
    const messages = lint(
      "code-flow",
      "no-bare-date-now",
      "export const now = () => Date.now();",
      "src/lib/time/clock.ts",
      [{ allowedPaths: ["src/lib/time/"] }]
    );

    expect(messages).toHaveLength(0);
  });

  test("allows new Date(timestamp) with explicit argument", () => {
    const messages = lint(
      "code-flow",
      "no-bare-date-now",
      "const d = new Date(1700000000000);",
      "src/utils/parse.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("allows routed clock calls", () => {
    const messages = lint(
      "code-flow",
      "no-bare-date-now",
      "import { now } from './clock'; const t = now();",
      "src/api/events.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("code-flow: no-template-trim-empty-ternary", () => {
  test("reports template.trim() === '' ternary", () => {
    const messages = lint(
      "code-flow",
      "no-template-trim-empty-ternary",
      "const display = `${first} ${last}`.trim() === '' ? email : `${first} ${last}`.trim();",
      "src/utils/display.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("extractToUtil");
  });

  test("reports template.trim() !== '' ternary", () => {
    const messages = lint(
      "code-flow",
      "no-template-trim-empty-ternary",
      "const display = `${first}`.trim() !== '' ? `${first}`.trim() : email;",
      "src/utils/display.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("extractToUtil");
  });

  test("allows plain string comparison", () => {
    const messages = lint(
      "code-flow",
      "no-template-trim-empty-ternary",
      "const x = name === '' ? fallback : name;",
      "src/utils/display.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("allows template without trim", () => {
    const messages = lint(
      "code-flow",
      "no-template-trim-empty-ternary",
      "const x = `${a}${b}` === '' ? a : b;",
      "src/utils/display.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("allows extracted utility call", () => {
    const messages = lint(
      "code-flow",
      "no-template-trim-empty-ternary",
      "const display = buildDisplayName({ first, last, fallback: email });",
      "src/utils/display.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("code-flow: prefer-early-return", () => {
  test("reports wrapped happy path in if statement", () => {
    const messages = lint(
      "code-flow",
      "prefer-early-return",
      `function processUser(user: any) {
  if (user.active) {
    console.log('Processing...');
    saveUser(user);
  }
}`,
      "src/services/users.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("preferEarlyReturn");
  });

  test("allows early return guard clause", () => {
    const messages = lint(
      "code-flow",
      "prefer-early-return",
      `function processUser(user: any) {
  if (!user.active) {
    return;
  }
  console.log('Processing...');
  saveUser(user);
}`,
      "src/services/users.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("allows if with else block", () => {
    const messages = lint(
      "code-flow",
      "prefer-early-return",
      `function processUser(user: any) {
  if (user.active) {
    saveUser(user);
  } else {
    markInactive(user);
  }
}`,
      "src/services/users.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("comment-hygiene: no-historical-comments", () => {
  test("reports historical comment with 'we used to'", () => {
    const messages = lint(
      "comment-hygiene",
      "no-historical-comments",
      "// We used to read from legacy cache.",
      "src/api/data.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("historicalComment");
  });

  test("reports 'before the fix' comment", () => {
    const messages = lint(
      "comment-hygiene",
      "no-historical-comments",
      "// Before the fix, this would crash.",
      "src/api/handler.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("historicalComment");
  });

  test("allows technical prose mentioning 'now'", () => {
    const messages = lint(
      "comment-hygiene",
      "no-historical-comments",
      "// Returns the user record matching the trimmed email.",
      "src/db/queries.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("allows JSDoc comments", () => {
    const messages = lint(
      "comment-hygiene",
      "no-historical-comments",
      `/** Before the refactor, this was complex. */ function f() {}`,
      "src/api/handler.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("comment-hygiene: no-narration-comments", () => {
  test("reports 'Here we' narrative comment", () => {
    const messages = lint(
      "comment-hygiene",
      "no-narration-comments",
      "// Here we set up the connection.",
      "src/db/setup.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("narrationComment");
  });

  test("reports 'First, we' narrative comment", () => {
    const messages = lint(
      "comment-hygiene",
      "no-narration-comments",
      "// First, validate the input.",
      "src/api/handler.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("narrationComment");
  });

  test("reports 'Now we' narrative comment", () => {
    const messages = lint(
      "comment-hygiene",
      "no-narration-comments",
      "// Now we iterate over the list.",
      "src/utils/process.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("narrationComment");
  });

  test("allows technical comments with context words", () => {
    const messages = lint(
      "comment-hygiene",
      "no-narration-comments",
      "// Locked-down because Stripe replays at-least-once.",
      "src/webhooks/handler.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("allows JSDoc narrative style", () => {
    const messages = lint(
      "comment-hygiene",
      "no-narration-comments",
      `/** Here's how it works. */ function f() {}`,
      "src/api/handler.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("comment-hygiene: no-pr-reference-comments", () => {
  test("reports PR number reference", () => {
    const messages = lint(
      "comment-hygiene",
      "no-pr-reference-comments",
      "// PR #123 introduced this guard.",
      "src/api/handler.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("prReferenceComment");
  });

  test("reports GitHub PR URL", () => {
    const messages = lint(
      "comment-hygiene",
      "no-pr-reference-comments",
      "// see https://github.com/foo/bar/pull/42 for context",
      "src/api/handler.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("prReferenceComment");
  });

  test("reports 'closes #N' reference", () => {
    const messages = lint(
      "comment-hygiene",
      "no-pr-reference-comments",
      "// closes #789",
      "src/api/handler.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("prReferenceComment");
  });

  test("allows reference to documentation", () => {
    const messages = lint(
      "comment-hygiene",
      "no-pr-reference-comments",
      "// see README.md for setup steps.",
      "src/api/handler.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("allows hashtag not referring to PR", () => {
    const messages = lint(
      "comment-hygiene",
      "no-pr-reference-comments",
      "// #dnsteam owns DNS rotation, not us.",
      "src/api/handler.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("test-conventions: no-focused-tests", () => {
  test("reports test.only()", () => {
    const messages = lint(
      "test-conventions",
      "no-focused-tests",
      "test.only('my test', () => {});",
      "src/example.test.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("focusedTest");
  });

  test("reports fdescribe()", () => {
    const messages = lint(
      "test-conventions",
      "no-focused-tests",
      "fdescribe('group', () => {});",
      "src/example.test.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("focusedTest");
  });

  test("reports describe.only()", () => {
    const messages = lint(
      "test-conventions",
      "no-focused-tests",
      "describe.only('group', () => {});",
      "src/example.test.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("focusedTest");
  });

  test("reports it.only()", () => {
    const messages = lint(
      "test-conventions",
      "no-focused-tests",
      "it.only('test', () => {});",
      "src/example.test.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("focusedTest");
  });

  test("allows normal test()", () => {
    const messages = lint(
      "test-conventions",
      "no-focused-tests",
      "test('my test', () => {});",
      "src/example.test.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("allows test.skip()", () => {
    const messages = lint(
      "test-conventions",
      "no-focused-tests",
      "test.skip('skipped', () => {});",
      "src/example.test.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("test-conventions: no-conditional-expect", () => {
  test("reports expect inside if", () => {
    const messages = lint(
      "test-conventions",
      "no-conditional-expect",
      "if (ready) { expect(value).toBe(1); }",
      "src/example.test.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("conditionalExpect");
  });

  test("allows top-level expect", () => {
    const messages = lint(
      "test-conventions",
      "no-conditional-expect",
      "expect(value).toBe(1);",
      "src/example.test.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("test-conventions: fake-timers-must-be-restored", () => {
  test("reports useFakeTimers without restore", () => {
    const messages = lint(
      "test-conventions",
      "fake-timers-must-be-restored",
      "vi.useFakeTimers();",
      "src/example.test.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("timersNotRestored");
  });

  test("allows useFakeTimers with useRealTimers", () => {
    const messages = lint(
      "test-conventions",
      "fake-timers-must-be-restored",
      "vi.useFakeTimers();\nvi.useRealTimers();",
      "src/example.test.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("test-conventions: no-real-network-in-unit-tests", () => {
  test("reports fetch in unit test", () => {
    const messages = lint(
      "test-conventions",
      "no-real-network-in-unit-tests",
      'await fetch("https://example.com");',
      "src/users/users.service.test.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("realNetworkInUnitTest");
  });

  test("allows fetch in integration test file", () => {
    const messages = lint(
      "test-conventions",
      "no-real-network-in-unit-tests",
      'await fetch("https://example.com");',
      "src/users/users.integration.test.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("test-conventions: test-file-mirrors-source", () => {
  test("reports orphaned test file (no matching source)", () => {
    // Stub filesystem to indicate only expected source exists
    const cwd = process.cwd();

    setFileExistsForTesting((p) => {
      return p === `${cwd}/src/users/users.service.ts`;
    });

    const messages = lint(
      "test-conventions",
      "test-file-mirrors-source",
      "// test code",
      "tests/users/orphan.test.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("orphanedTest");
  });

  test("allows test when source exists", () => {
    const cwd = process.cwd();

    setFileExistsForTesting((p) => {
      return p === `${cwd}/src/users/users.service.ts`;
    });

    const messages = lint(
      "test-conventions",
      "test-file-mirrors-source",
      "// test code",
      "tests/users/users.service.test.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("allows non-test files in tests directory", () => {
    setFileExistsForTesting(() => false);
    const messages = lint(
      "test-conventions",
      "test-file-mirrors-source",
      "export const helper = 1;",
      "tests/helpers/db.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("allows source files (ignores rule outside tests/)", () => {
    setFileExistsForTesting(() => false);
    const messages = lint(
      "test-conventions",
      "test-file-mirrors-source",
      "export const x = 1;",
      "src/api/handler.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("restores real filesystem after test", () => {
    // Reset to real fs.existsSync behavior
    setFileExistsForTesting(null);
    // This test verifies the helper can be reset; actual filesystem check would need real files
  });
});

// ===== DRIZZLE PACK TESTS =====

describe("drizzle pack", () => {
  test("should export drizzlePack with correct structure", () => {
    const pack = RULE_PACKS.drizzle;

    expect(pack.id).toBe("drizzle");
    expect(pack.description).toContain("Drizzle ORM");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "account-scoped-tables-require-where",
      "no-nested-db-transaction",
      "no-raw-sql-outside-allowlist",
      "relations-must-cover-fks",
      "schema-files-must-not-import-driver",
      "schema-files-must-only-export-schema",
      "tables-must-have-timestamps",
      "timestamp-must-specify-mode",
      "update-delete-account-scoped-must-filter-scope",
      "update-delete-must-have-where",
    ]);
  });

  test("account-scoped-tables-require-where: rule exists and is callable", () => {
    const rule =
      RULE_PACKS.drizzle.rules["account-scoped-tables-require-where"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("account-scoped");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("account-scoped-tables-require-where: detects missing scope filter on select", () => {
    const messages = lint(
      "drizzle",
      "account-scoped-tables-require-where",
      "const users = db.select().from(usersTable);",
      "src/db/queries.ts",
      [{ tables: ["usersTable"], scopeColumn: "accountId" }]
    );

    expect(messages.map((m) => m.messageId)).toContain("missingScopeFilter");
  });

  test("account-scoped-tables-require-where: allows queries with scope filter", () => {
    const messages = lint(
      "drizzle",
      "account-scoped-tables-require-where",
      "const users = db.select().from(usersTable).where(eq(usersTable.accountId, id));",
      "src/db/queries.ts",
      [{ tables: ["usersTable"], scopeColumn: "accountId" }]
    );

    expect(
      messages.some((m) => m.messageId === "missingScopeFilter")
    ).toBeFalsy();
  });

  test("update-delete-must-have-where: reports delete without where", () => {
    const messages = lint(
      "drizzle",
      "update-delete-must-have-where",
      "await db.delete(usersTable);",
      "src/db/queries.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("missingWhere");
  });

  test("update-delete-must-have-where: allows delete with where", () => {
    const messages = lint(
      "drizzle",
      "update-delete-must-have-where",
      "await db.delete(usersTable).where(eq(usersTable.id, id));",
      "src/db/queries.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("update-delete-account-scoped-must-filter-scope: reports missing scope on update", () => {
    const messages = lint(
      "drizzle",
      "update-delete-account-scoped-must-filter-scope",
      "await db.update(usersTable).set({ name: 'x' }).where(eq(usersTable.id, id));",
      "src/db/queries.ts",
      [{ tables: ["usersTable"], scopeColumn: "accountId" }]
    );

    expect(messages.map((m) => m.messageId)).toContain("missingScopeFilter");
  });

  test("update-delete-account-scoped-must-filter-scope: allows scoped update", () => {
    const messages = lint(
      "drizzle",
      "update-delete-account-scoped-must-filter-scope",
      "await db.update(usersTable).set({ name: 'x' }).where(eq(usersTable.accountId, accountId));",
      "src/db/queries.ts",
      [{ tables: ["usersTable"], scopeColumn: "accountId" }]
    );

    expect(messages).toHaveLength(0);
  });

  test("no-nested-db-transaction: reports nested db.transaction calls", () => {
    const code = `
      await db.transaction(async (tx) => {
        await db.transaction(async (tx2) => {});
      });
    `;

    const messages = lint(
      "drizzle",
      "no-nested-db-transaction",
      code,
      "src/db/migrations.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("nestedTransaction");
  });

  test("no-nested-db-transaction: allows nested with proper tx parameter", () => {
    const code = `
      await db.transaction(async (tx) => {
        await tx.transaction(async (tx2) => {});
      });
    `;

    const messages = lint(
      "drizzle",
      "no-nested-db-transaction",
      code,
      "src/db/migrations.ts"
    );

    expect(
      messages.some((m) => m.messageId === "nestedTransaction")
    ).toBeFalsy();
  });

  test("no-raw-sql-outside-allowlist: reports sql in non-allowed file", () => {
    const messages = lint(
      "drizzle",
      "no-raw-sql-outside-allowlist",
      "import { sql } from 'drizzle-orm';\nconst result = sql`SELECT 1`;",
      "src/db/queries.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("noRawSql");
  });

  test("no-raw-sql-outside-allowlist: allows sql with custom allowFiles option", () => {
    const messages = lint(
      "drizzle",
      "no-raw-sql-outside-allowlist",
      "import { sql } from 'drizzle-orm';\nconst result = sql`SELECT 1`;",
      "src/db/queries.ts",
      [{ allowFiles: ["src/db/queries.ts"] }]
    );

    expect(messages.some((m) => m.messageId === "noRawSql")).toBeFalsy();
  });

  test("relations-must-cover-fks: rule exists and is callable", () => {
    const rule = RULE_PACKS.drizzle.rules["relations-must-cover-fks"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("relations");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("schema-files-must-not-import-driver: rule exists and is callable", () => {
    const rule =
      RULE_PACKS.drizzle.rules["schema-files-must-not-import-driver"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("schema files");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("schema-files-must-only-export-schema: rule exists and is callable", () => {
    const rule =
      RULE_PACKS.drizzle.rules["schema-files-must-only-export-schema"]!;

    expect(rule.meta.type).toBe("suggestion");
    expect(rule.meta.docs?.description).toContain("schema");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("tables-must-have-timestamps: reports missing createdAt column", () => {
    const messages = lint(
      "drizzle",
      "tables-must-have-timestamps",
      "const users = pgTable('users', { id: serial('id').primaryKey(), name: text('name') });",
      "src/schema/users.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("missingTimestamp");
  });

  test("tables-must-have-timestamps: allows tables with createdAt", () => {
    const messages = lint(
      "drizzle",
      "tables-must-have-timestamps",
      "const users = pgTable('users', { id: serial('id').primaryKey(), createdAt: timestamp('createdAt') });",
      "src/schema/users.ts"
    );

    expect(
      messages.some((m) => m.messageId === "missingTimestamp")
    ).toBeFalsy();
  });

  test("timestamp-must-specify-mode: reports missing mode option", () => {
    const messages = lint(
      "drizzle",
      "timestamp-must-specify-mode",
      "const col = timestamp('created');"
    );

    expect(messages.map((m) => m.messageId)).toContain("missingMode");
  });

  test("timestamp-must-specify-mode: allows explicit mode", () => {
    const messages = lint(
      "drizzle",
      "timestamp-must-specify-mode",
      "const col = timestamp('created', { mode: 'date' });"
    );

    expect(messages.some((m) => m.messageId === "missingMode")).toBeFalsy();
  });
});

// ===== BULLMQ PACK TESTS =====

describe("bullmq pack", () => {
  test("should export bullmqPack with correct structure", () => {
    const pack = RULE_PACKS.bullmq;

    expect(pack.id).toBe("bullmq");
    expect(pack.description).toContain("BullMQ");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "job-name-must-be-constant",
      "job-options-must-set-attempts",
      "no-blocking-concurrency-zero",
      "queue-options-must-set-removeoncomplete",
      "queue-options-must-set-removeonfail",
      "worker-must-implement-close",
      "worker-must-listen-failed",
    ]);
  });

  test("job-name-must-be-constant: rule exists and is callable", () => {
    const rule = RULE_PACKS.bullmq.rules["job-name-must-be-constant"]!;

    expect(rule.meta.type).toBe("suggestion");
    expect(rule.meta.docs?.description).toContain("job name");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("job-options-must-set-attempts: rule exists and is callable", () => {
    const rule = RULE_PACKS.bullmq.rules["job-options-must-set-attempts"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("attempts");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("no-blocking-concurrency-zero: rule exists and is callable", () => {
    const rule = RULE_PACKS.bullmq.rules["no-blocking-concurrency-zero"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("concurrency");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("queue-options-must-set-removeoncomplete: rule exists and is callable", () => {
    const rule =
      RULE_PACKS.bullmq.rules["queue-options-must-set-removeoncomplete"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("removeOnComplete");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("queue-options-must-set-removeonfail: rule exists and is callable", () => {
    const rule =
      RULE_PACKS.bullmq.rules["queue-options-must-set-removeonfail"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("removeOnFail");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("worker-must-implement-close: rule exists and is callable", () => {
    const rule = RULE_PACKS.bullmq.rules["worker-must-implement-close"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("close");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("worker-must-listen-failed: rule exists and is callable", () => {
    const rule = RULE_PACKS.bullmq.rules["worker-must-listen-failed"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("failed");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("job-name-must-be-constant: detects inline string literal job name", () => {
    const code = `
      import { Queue } from "bullmq";
      const emailQueue = new Queue("email");
      emailQueue.add("send-email", { to: "user@example.com" });
    `;
    const messages = lint("bullmq", "job-name-must-be-constant", code);

    expect(messages.map((m) => m.messageId)).toContain("literalJobName");
  });

  test("job-name-must-be-constant: allows constant identifier job name", () => {
    const code = `
      import { Queue } from "bullmq";
      const JOB_NAMES = { SendEmail: "send-email" } as const;
      const emailQueue = new Queue("email");
      emailQueue.add(JOB_NAMES.SendEmail, { to: "user@example.com" });
    `;
    const messages = lint("bullmq", "job-name-must-be-constant", code);

    expect(messages.some((m) => m.messageId === "literalJobName")).toBeFalsy();
  });

  test("job-options-must-set-attempts: detects missing attempts option", () => {
    const code = `
      import { Queue } from "bullmq";
      const emailQueue = new Queue("email");
      emailQueue.add("send", {}, {});
    `;
    const messages = lint("bullmq", "job-options-must-set-attempts", code);

    expect(messages.map((m) => m.messageId)).toContain("missingAttempts");
  });

  test("job-options-must-set-attempts: allows attempts in per-call options", () => {
    const code = `
      import { Queue } from "bullmq";
      const emailQueue = new Queue("email");
      emailQueue.add("send", {}, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
    `;
    const messages = lint("bullmq", "job-options-must-set-attempts", code);

    expect(messages.some((m) => m.messageId === "missingAttempts")).toBeFalsy();
  });

  test("job-options-must-set-attempts: detects missing backoff when attempts > 1", () => {
    const code = `
      import { Queue } from "bullmq";
      const emailQueue = new Queue("email");
      emailQueue.add("send", {}, { attempts: 5 });
    `;
    const messages = lint("bullmq", "job-options-must-set-attempts", code);

    expect(messages.map((m) => m.messageId)).toContain("missingBackoff");
  });

  test("job-options-must-set-attempts: allows attempts=1 without backoff", () => {
    const code = `
      import { Queue } from "bullmq";
      const emailQueue = new Queue("email");
      emailQueue.add("send", {}, { attempts: 1 });
    `;
    const messages = lint("bullmq", "job-options-must-set-attempts", code);

    expect(messages.some((m) => m.messageId === "missingBackoff")).toBeFalsy();
  });

  test("no-blocking-concurrency-zero: detects concurrency set to 0", () => {
    const code = `
      import { Worker } from "bullmq";
      new Worker("queue", async () => {}, { concurrency: 0 });
    `;
    const messages = lint("bullmq", "no-blocking-concurrency-zero", code);

    expect(messages.map((m) => m.messageId)).toContain("invalidConcurrency");
  });

  test("no-blocking-concurrency-zero: detects negative concurrency", () => {
    const code = `
      import { Worker } from "bullmq";
      new Worker("queue", async () => {}, { concurrency: -1 });
    `;
    const messages = lint("bullmq", "no-blocking-concurrency-zero", code);

    expect(messages.map((m) => m.messageId)).toContain("invalidConcurrency");
  });

  test("no-blocking-concurrency-zero: allows positive concurrency", () => {
    const code = `
      import { Worker } from "bullmq";
      new Worker("queue", async () => {}, { concurrency: 5 });
    `;
    const messages = lint("bullmq", "no-blocking-concurrency-zero", code);

    expect(
      messages.some((m) => m.messageId === "invalidConcurrency")
    ).toBeFalsy();
  });

  test("queue-options-must-set-removeoncomplete: detects missing removeOnComplete", () => {
    const code = `
      import { Queue } from "bullmq";
      const emailQueue = new Queue("email");
      emailQueue.add("send", {});
    `;
    const messages = lint(
      "bullmq",
      "queue-options-must-set-removeoncomplete",
      code
    );

    expect(messages.map((m) => m.messageId)).toContain(
      "missingRemoveOnComplete"
    );
  });

  test("queue-options-must-set-removeoncomplete: allows removeOnComplete in per-call options", () => {
    const code = `
      import { Queue } from "bullmq";
      const emailQueue = new Queue("email");
      emailQueue.add("send", {}, { removeOnComplete: true });
    `;
    const messages = lint(
      "bullmq",
      "queue-options-must-set-removeoncomplete",
      code
    );

    expect(
      messages.some((m) => m.messageId === "missingRemoveOnComplete")
    ).toBeFalsy();
  });

  test("queue-options-must-set-removeoncomplete: allows removeOnComplete via defaultJobOptions", () => {
    const code = `
      import { Queue } from "bullmq";
      const emailQueue = new Queue("email", {
        defaultJobOptions: { removeOnComplete: true }
      });
      emailQueue.add("send", {});
    `;
    const messages = lint(
      "bullmq",
      "queue-options-must-set-removeoncomplete",
      code
    );

    expect(
      messages.some((m) => m.messageId === "missingRemoveOnComplete")
    ).toBeFalsy();
  });

  test("queue-options-must-set-removeonfail: detects missing removeOnFail", () => {
    const code = `
      import { Queue } from "bullmq";
      const emailQueue = new Queue("email");
      emailQueue.add("send", {});
    `;
    const messages = lint(
      "bullmq",
      "queue-options-must-set-removeonfail",
      code
    );

    expect(messages.map((m) => m.messageId)).toContain("missingRemoveOnFail");
  });

  test("queue-options-must-set-removeonfail: allows removeOnFail in per-call options", () => {
    const code = `
      import { Queue } from "bullmq";
      const emailQueue = new Queue("email");
      emailQueue.add("send", {}, { removeOnFail: 5000 });
    `;
    const messages = lint(
      "bullmq",
      "queue-options-must-set-removeonfail",
      code
    );

    expect(
      messages.some((m) => m.messageId === "missingRemoveOnFail")
    ).toBeFalsy();
  });

  test("queue-options-must-set-removeonfail: allows removeOnFail via defaultJobOptions", () => {
    const code = `
      import { Queue } from "bullmq";
      const emailQueue = new Queue("email", {
        defaultJobOptions: { removeOnFail: 5000 }
      });
      emailQueue.add("send", {});
    `;
    const messages = lint(
      "bullmq",
      "queue-options-must-set-removeonfail",
      code
    );

    expect(
      messages.some((m) => m.messageId === "missingRemoveOnFail")
    ).toBeFalsy();
  });

  test("worker-must-implement-close: detects missing close method in worker-owning class", () => {
    const code = `
      import { Worker } from "bullmq";
      export class EmailService {
        private worker = new Worker("email", async () => {});
      }
    `;
    const messages = lint("bullmq", "worker-must-implement-close", code);

    expect(messages.map((m) => m.messageId)).toContain("missingClose");
  });

  test("worker-must-implement-close: allows class with close method", () => {
    const code = `
      import { Worker } from "bullmq";
      export class EmailService {
        private worker = new Worker("email", async () => {});
        async close() {
          await this.worker.close();
        }
      }
    `;
    const messages = lint("bullmq", "worker-must-implement-close", code);

    expect(messages.some((m) => m.messageId === "missingClose")).toBeFalsy();
  });

  test("worker-must-implement-close: allows alternative shutdown methods", () => {
    const code = `
      import { Worker } from "bullmq";
      export class EmailService {
        private worker = new Worker("email", async () => {});
        async onModuleDestroy() {
          await this.worker.close();
        }
      }
    `;
    const messages = lint("bullmq", "worker-must-implement-close", code);

    expect(messages.some((m) => m.messageId === "missingClose")).toBeFalsy();
  });

  test("worker-must-listen-failed: detects missing failed event listener on worker", () => {
    const code = `
      import { Worker } from "bullmq";
      const worker = new Worker("queue", async () => {});
      worker.on("completed", () => {});
    `;
    const messages = lint("bullmq", "worker-must-listen-failed", code);

    expect(messages.map((m) => m.messageId)).toContain("missingListener");
  });

  test("worker-must-listen-failed: detects missing listener in inline worker", () => {
    const code = `
      import { Worker } from "bullmq";
      const worker = new Worker("queue", async () => {});
      worker.on("completed", () => {});
    `;
    const messages = lint("bullmq", "worker-must-listen-failed", code);

    expect(messages.map((m) => m.messageId)).toContain("missingListener");
  });

  test("worker-must-listen-failed: detects missing listener in class worker", () => {
    const code = `
      import { Worker } from "bullmq";
      export class EmailService {
        private worker = new Worker("queue", async () => {});
        async close() { await this.worker.close(); }
      }
    `;
    const messages = lint("bullmq", "worker-must-listen-failed", code);

    expect(messages.map((m) => m.messageId)).toContain("missingListener");
  });
});

describe("elysia pack", () => {
  test("should export elysiaPack with correct structure", () => {
    const pack = RULE_PACKS.elysia;

    expect(pack.id).toBe("elysia");
    expect(pack.description).toContain("Elysia");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "consistent-status-via-set",
      "no-decorate-state-collision",
      "no-separate-model-interfaces",
      "prefer-destructured-context",
      "prefer-direct-return",
      "prefer-static-services",
      "prefer-throw-status",
      "require-elysia-plugin-name",
      "require-hooks-before-routes",
    ]);
  });

  test("consistent-status-via-set: reports Response wrapping in routes", () => {
    const code = `
      const app = new Elysia();
      app.get("/", () => {
        return new Response("Hello", { status: 200 });
      });
    `;
    const messages = lint("elysia", "consistent-status-via-set", code);

    expect(messages.map((m) => m.messageId)).toContain("useSetStatus");
  });

  test("consistent-status-via-set: allows direct return without status", () => {
    const code = `
      const app = new Elysia();
      app.get("/", () => {
        return "Hello";
      });
    `;
    const messages = lint("elysia", "consistent-status-via-set", code);

    expect(messages).toHaveLength(0);
  });

  test("no-decorate-state-collision: reports duplicate key in .decorate()", () => {
    const code = `
      const app = new Elysia()
        .decorate("db", createDb())
        .decorate("db", createCache());
    `;
    const messages = lint("elysia", "no-decorate-state-collision", code);

    expect(messages.map((m) => m.messageId)).toContain("decorateKeyCollision");
  });

  test("no-decorate-state-collision: allows distinct keys", () => {
    const code = `
      const app = new Elysia()
        .decorate("db", createDb())
        .decorate("cache", createCache());
    `;
    const messages = lint("elysia", "no-decorate-state-collision", code);

    expect(messages).toHaveLength(0);
  });

  test("no-separate-model-interfaces: reports duplicate Schema interface", () => {
    const code = `
      const UserSchema = t.Object({ name: t.String() });
      interface User { name: string; }
    `;
    const messages = lint("elysia", "no-separate-model-interfaces", code);

    expect(messages.map((m) => m.messageId)).toContain(
      "noSeparateModelInterface"
    );
  });

  test("no-separate-model-interfaces: allows distinct names", () => {
    const code = `
      const UserSchema = t.Object({ name: t.String() });
      interface Profile { bio: string; }
    `;
    const messages = lint("elysia", "no-separate-model-interfaces", code);

    expect(messages).toHaveLength(0);
  });

  test("prefer-direct-return: reports Response.json() wrapper", () => {
    const code = `
      const app = new Elysia();
      app.get("/users", () => {
        return Response.json({ id: 1, name: "Alice" });
      });
    `;
    const messages = lint("elysia", "prefer-direct-return", code);

    expect(messages.map((m) => m.messageId)).toContain("preferDirectReturn");
  });

  test("prefer-direct-return: allows direct object return", () => {
    const code = `
      const app = new Elysia();
      app.get("/users", () => {
        return { id: 1, name: "Alice" };
      });
    `;
    const messages = lint("elysia", "prefer-direct-return", code);

    expect(messages).toHaveLength(0);
  });

  test("prefer-throw-status: reports try/catch with response in route", () => {
    const code = `
      const app = new Elysia();
      app.post("/users", async () => {
        try {
          return await createUser();
        } catch (e) {
          return new Response("Error", { status: 500 });
        }
      });
    `;
    const messages = lint("elysia", "prefer-throw-status", code);

    expect(messages.map((m) => m.messageId)).toContain("preferThrowStatus");
  });

  test("prefer-throw-status: allows try/catch outside routes", () => {
    const code = `
      function safeCreate() {
        try {
          return createUser();
        } catch (e) {
          return null;
        }
      }
    `;
    const messages = lint("elysia", "prefer-throw-status", code);

    expect(messages).toHaveLength(0);
  });

  test("require-hooks-before-routes: reports hook after route", () => {
    const code = `
      const app = new Elysia()
        .get("/", () => "hello")
        .onError((ctx) => {});
    `;
    const messages = lint("elysia", "require-hooks-before-routes", code);

    expect(messages.map((m) => m.messageId)).toContain("hookAfterRoute");
  });

  test("require-hooks-before-routes: allows hooks before routes", () => {
    const code = `
      const app = new Elysia()
        .onError((ctx) => {})
        .get("/", () => "hello");
    `;
    const messages = lint("elysia", "require-hooks-before-routes", code);

    expect(messages).toHaveLength(0);
  });

  test("require-elysia-plugin-name: reports unnamed exported Elysia instance", () => {
    const code = `
      export const plugin = new Elysia();
    `;
    const messages = lint("elysia", "require-elysia-plugin-name", code);

    expect(messages.map((m) => m.messageId)).toContain("missingPluginName");
  });

  test("require-elysia-plugin-name: allows named plugin export", () => {
    const code = `
      export const plugin = new Elysia({ name: "auth-plugin" });
    `;
    const messages = lint("elysia", "require-elysia-plugin-name", code);

    expect(messages).toHaveLength(0);
  });
});

describe("structured-logging pack", () => {
  test("should export structuredLoggingPack with correct structure", () => {
    const pack = RULE_PACKS["structured-logging"];

    expect(pack.id).toBe("structured-logging");
    expect(pack.description).toContain("Structured logging");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "caught-error-log-requires-cause",
      "logger-not-console",
      "mask-pii-fields",
      "no-error-stringify",
      "require-event-field",
    ]);
  });

  test("mask-pii-fields: reports unmasked email in log payload", () => {
    const code = `
      logger.info({ event: "user_created", email: user.email });
    `;
    const messages = lint("structured-logging", "mask-pii-fields", code);

    expect(messages.map((m) => m.messageId)).toContain("unmaskedPii");
  });

  test("mask-pii-fields: allows masked PII field", () => {
    const code = `
      logger.info({ event: "user_created", email: maskEmailForLogging(user.email) });
    `;
    const messages = lint("structured-logging", "mask-pii-fields", code);

    expect(messages).toHaveLength(0);
  });

  test("mask-pii-fields: allows literal mask value", () => {
    const code = `
      logger.info({ event: "user_created", email: "[REDACTED]" });
    `;
    const messages = lint("structured-logging", "mask-pii-fields", code);

    expect(messages).toHaveLength(0);
  });

  test("no-error-stringify: reports String(error)", () => {
    const code = `
      logger.error({ event: "error", message: String(error) });
    `;
    const messages = lint("structured-logging", "no-error-stringify", code);

    expect(messages.map((m) => m.messageId)).toContain("noErrorStringify");
  });

  test("no-error-stringify: reports error.toString()", () => {
    const code = `
      logger.error({ event: "error", message: error.toString() });
    `;
    const messages = lint("structured-logging", "no-error-stringify", code);

    expect(messages.map((m) => m.messageId)).toContain("noErrorStringify");
  });

  test("no-error-stringify: reports template literal with error", () => {
    const code = `
      logger.error({ event: "error", message: \`Error: \${error}\` });
    `;
    const messages = lint("structured-logging", "no-error-stringify", code);

    expect(messages.map((m) => m.messageId)).toContain("noErrorStringify");
  });

  test("no-error-stringify: allows extractor function call", () => {
    const code = `
      import { getErrorMessage } from "@/lib/errors";
      logger.error({ event: "error", message: getErrorMessage(error) });
    `;
    const messages = lint("structured-logging", "no-error-stringify", code);

    expect(messages).toHaveLength(0);
  });

  test("require-event-field: reports missing event field", () => {
    const code = `
      logger.info({ message: "Something happened" });
    `;
    const messages = lint("structured-logging", "require-event-field", code);

    expect(messages.map((m) => m.messageId)).toContain("missingEventField");
  });

  test("require-event-field: allows event field in payload", () => {
    const code = `
      logger.info({ event: "user_created", userId: 123 });
    `;
    const messages = lint("structured-logging", "require-event-field", code);

    expect(messages).toHaveLength(0);
  });

  test("require-event-field: allows spread with potential event field", () => {
    const code = `
      logger.info({ ...payload, extra: "data" });
    `;
    const messages = lint("structured-logging", "require-event-field", code);

    expect(messages).toHaveLength(0);
  });

  test("logger-not-console: reports console.log in service file", () => {
    const messages = lint(
      "structured-logging",
      "logger-not-console",
      'console.log("debug");',
      "src/users/users.service.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("consoleInService");
  });

  test("logger-not-console: ignores console in non-service file", () => {
    const messages = lint(
      "structured-logging",
      "logger-not-console",
      'console.log("debug");',
      "src/components/Button.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("caught-error-log-requires-cause: reports missing cause field", () => {
    const messages = lint(
      "structured-logging",
      "caught-error-log-requires-cause",
      `try { work(); } catch (error) { logger.error({ event: "failed", err: error }); }`
    );

    expect(messages.map((m) => m.messageId)).toContain("missingCause");
  });

  test("caught-error-log-requires-cause: allows cause field", () => {
    const messages = lint(
      "structured-logging",
      "caught-error-log-requires-cause",
      `try { work(); } catch (error) { logger.error({ event: "failed", cause: error }); }`
    );

    expect(messages).toHaveLength(0);
  });
});

describe("react-component-architecture pack", () => {
  test("should export reactComponentArchitecturePack with correct structure", () => {
    const pack = RULE_PACKS["react-component-architecture"];

    expect(pack.id).toBe("react-component-architecture");
    expect(pack.description).toContain("Component structure");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "component-file-purity",
      "component-folder-structure",
      "dangerous-html-requires-sanitize",
      "forwardref-display-name",
      "index-must-reexport-default",
      "max-hooks-per-file",
      "no-anonymous-useEffect",
      "no-component-invocation",
      "no-cross-feature-imports",
      "no-derived-state-in-effect",
      "no-inline-jsx-functions",
      "no-jsx-computation",
      "no-loading-text-use-skeleton",
      "no-nested-component",
      "no-react-fc",
      "no-state-in-component-body",
    ]);
  });

  test("no-loading-text-use-skeleton: flags a 'Loading…' text node", () => {
    const code = `export function View() { return <div>Loading...</div>; }`;
    const messages = lint(
      "react-component-architecture",
      "no-loading-text-use-skeleton",
      code,
      "src/views/Deals/index.tsx"
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe("useSkeleton");
  });

  test("no-loading-text-use-skeleton: flags bare 'Loading' and the ellipsis form", () => {
    for (const text of ["Loading", "Loading…", "loading...", "LOADING"]) {
      const messages = lint(
        "react-component-architecture",
        "no-loading-text-use-skeleton",
        `export function View() { return <span>${text}</span>; }`,
        "src/views/Deals/index.tsx"
      );

      expect(messages).toHaveLength(1);
    }
  });

  test("no-loading-text-use-skeleton: passes when rendering a Skeleton", () => {
    const code = `export function View() { return <Skeleton className="h-8 w-full" />; }`;
    const messages = lint(
      "react-component-architecture",
      "no-loading-text-use-skeleton",
      code,
      "src/views/Deals/index.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-loading-text-use-skeleton: a sentence merely containing 'loading' is fine", () => {
    const code = `export function View() { return <p>Avoid loading the page twice.</p>; }`;
    const messages = lint(
      "react-component-architecture",
      "no-loading-text-use-skeleton",
      code,
      "src/views/Deals/index.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("component-folder-structure: rule exists and is callable", () => {
    const rule =
      RULE_PACKS["react-component-architecture"].rules[
        "component-folder-structure"
      ]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("component");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("component-folder-structure: allows a feature component under views/<F>/components/", () => {
    const code = `export function DealsTable() { return <div />; }`;
    const messages = lint(
      "react-component-architecture",
      "component-folder-structure",
      code,
      "src/views/Dashboard/components/DealsTable.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("component-folder-structure: allows a shared primitive under components/ui/", () => {
    const code = `export function Table() { return <table />; }`;
    const messages = lint(
      "react-component-architecture",
      "component-folder-structure",
      code,
      "src/components/ui/table.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("component-folder-structure: rejects a component scattered outside views/", () => {
    const code = `export function DealsTable() { return <div />; }`;
    const messages = lint(
      "react-component-architecture",
      "component-folder-structure",
      code,
      "src/dashboard/DealsTable.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("wrongLocation");
  });

  test("component-folder-structure: rejects a component at the view root (not in components/)", () => {
    const code = `export function DealsTable() { return <div />; }`;
    const messages = lint(
      "react-component-architecture",
      "component-folder-structure",
      code,
      "src/views/Dashboard/DealsTable.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("wrongLocation");
  });

  test("component-file-purity: rule exists and is callable", () => {
    const rule =
      RULE_PACKS["react-component-architecture"].rules[
        "component-file-purity"
      ]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("component");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("component-file-purity: rejects an inline constant beside a component", () => {
    const code = `
      const STAGE_LABEL = { lead: "Lead" };
      export function DealsTable() { return <div>{STAGE_LABEL.lead}</div>; }
    `;
    const messages = lint(
      "react-component-architecture",
      "component-file-purity",
      code,
      "src/views/Dashboard/components/DealsTable.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("inlineConstant");
  });

  test("component-file-purity: rejects an inline helper function beside a component", () => {
    const code = `
      function formatCurrency(n: number): string { return String(n); }
      export function DealsTable() { return <div>{formatCurrency(1)}</div>; }
    `;
    const messages = lint(
      "react-component-architecture",
      "component-file-purity",
      code,
      "src/views/Dashboard/components/DealsTable.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("inlineHelper");
  });

  test("component-file-purity: rejects an inline type beside a component", () => {
    const code = `
      interface IProps { deals: readonly string[]; }
      export function DealsTable({ deals }: IProps) { return <div>{deals.length}</div>; }
    `;
    const messages = lint(
      "react-component-architecture",
      "component-file-purity",
      code,
      "src/views/Dashboard/components/DealsTable.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("inlineType");
  });

  test("component-file-purity: allows a pure component file (imports + component only)", () => {
    const code = `
      import { Table } from "@/components/ui/table";
      import { dealColumns } from "../dashboard.constants";
      import type { IDeal } from "../dashboard.types";

      export function DealsTable({ deals }: { deals: readonly IDeal[] }) {
        return <Table columns={dealColumns} data={deals} rowKey={(d) => d.id} />;
      }
    `;
    const messages = lint(
      "react-component-architecture",
      "component-file-purity",
      code,
      "src/views/Dashboard/components/DealsTable.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("component-file-purity: exempts shadcn ui primitives (cva variant consts)", () => {
    const code = `
      import { cva } from "class-variance-authority";
      const buttonVariants = cva("base");
      export function Button() { return <button type="button" />; }
    `;
    const messages = lint(
      "react-component-architecture",
      "component-file-purity",
      code,
      "src/components/ui/button.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("component-file-purity: exempts route shells (const Route = createFileRoute)", () => {
    const code = `
      import { createFileRoute } from "@tanstack/react-router";
      export const Route = createFileRoute("/dashboard")({ component: Page });
      function Page() { return <div />; }
    `;
    const messages = lint(
      "react-component-architecture",
      "component-file-purity",
      code,
      "src/routes/dashboard.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("forwardref-display-name: rule exists and is callable", () => {
    const rule =
      RULE_PACKS["react-component-architecture"].rules[
        "forwardref-display-name"
      ]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("forwardRef");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("index-must-reexport-default: rule exists and is callable", () => {
    const rule =
      RULE_PACKS["react-component-architecture"].rules[
        "index-must-reexport-default"
      ]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("index");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("max-hooks-per-file: rule exists and is callable", () => {
    const rule =
      RULE_PACKS["react-component-architecture"].rules["max-hooks-per-file"]!;

    expect(rule.meta.type).toBe("suggestion");
    expect(rule.meta.docs?.description).toContain("hook");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("no-cross-feature-imports: rule exists and is callable", () => {
    const rule =
      RULE_PACKS["react-component-architecture"].rules[
        "no-cross-feature-imports"
      ]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("feature");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("no-inline-jsx-functions: rule exists and is callable", () => {
    const rule =
      RULE_PACKS["react-component-architecture"].rules[
        "no-inline-jsx-functions"
      ]!;

    expect(rule.meta.type).toBe("suggestion");
    expect(rule.meta.docs?.description).toContain("inline function");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("no-jsx-computation: ALLOWS a simple list-render .map() inside JSX", () => {
    // Narrowed: a bare `{items.map((i) => <li/>)}` is the idiomatic React list
    // render and is no longer flagged (chained array ops still are — see below).
    const code = `
      export function List({ items }: { items: string[] }) {
        return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>;
      }
    `;
    const messages = lint(
      "react-component-architecture",
      "no-jsx-computation",
      code,
      "src/List.tsx"
    );

    expect(messages.map((m) => m.messageId)).not.toContain("noComputation");
  });

  test("no-jsx-computation: reports arithmetic in JSX", () => {
    const code = `
      export function Counter({ count }: { count: number }) {
        return <span>{count + 1}</span>;
      }
    `;
    const messages = lint(
      "react-component-architecture",
      "no-jsx-computation",
      code,
      "src/Counter.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("noComputation");
  });

  test("no-jsx-computation: allows identifier in JSX", () => {
    const code = `
      export function Greeting({ userName }: { userName: string }) {
        return <span>{userName}</span>;
      }
    `;
    const messages = lint(
      "react-component-architecture",
      "no-jsx-computation",
      code,
      "src/Greeting.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-jsx-computation: allows simple ternary by default", () => {
    const code = `
      export function Status({ active }: { active: boolean }) {
        return <span>{active ? "On" : "Off"}</span>;
      }
    `;
    const messages = lint(
      "react-component-architecture",
      "no-jsx-computation",
      code,
      "src/Status.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-jsx-computation: skips story files", () => {
    const code = `
      export function List({ items }: { items: string[] }) {
        return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>;
      }
    `;
    const messages = lint(
      "react-component-architecture",
      "no-jsx-computation",
      code,
      "src/List.stories.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-state-in-component-body: reports useState in component", () => {
    const code = `
      import { useState } from "react";
      export function Button() {
        const [open, setOpen] = useState(false);
        return <button>{open ? "Open" : "Closed"}</button>;
      }
    `;
    const messages = lint(
      "react-component-architecture",
      "no-state-in-component-body",
      code,
      "src/Button.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("noStateInComponent");
  });

  test("no-state-in-component-body: allows useId in component body", () => {
    const code = `
      import { useId } from "react";
      export function Field() {
        const id = useId();
        return <input id={id} />;
      }
    `;
    const messages = lint(
      "react-component-architecture",
      "no-state-in-component-body",
      code,
      "src/Field.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-state-in-component-body: skips hooks files", () => {
    const code = `
      import { useState } from "react";
      export function useButton() {
        const [open, setOpen] = useState(false);
        return { open, setOpen };
      }
    `;
    const messages = lint(
      "react-component-architecture",
      "no-state-in-component-body",
      code,
      "src/Button.hooks.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-state-in-component-body: skips test files", () => {
    const code = `
      import { useState } from "react";
      export function Button() {
        const [open, setOpen] = useState(false);
        return <button>{open ? "Open" : "Closed"}</button>;
      }
    `;
    const messages = lint(
      "react-component-architecture",
      "no-state-in-component-body",
      code,
      "src/Button.test.tsx"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("jwt-cookies pack", () => {
  test("should export jwtCookiesPack with correct structure", () => {
    const pack = RULE_PACKS["jwt-cookies"];

    expect(pack.id).toBe("jwt-cookies");
    expect(pack.description).toContain("JWT and cookie");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "auth-cookie-must-be-httponly",
      "auth-cookie-must-be-secure-in-prod",
      "auth-cookie-must-set-maxage-or-expires",
      "auth-cookie-must-set-samesite",
      "bcrypt-rounds-min",
      "jwt-must-verify-not-decode",
    ]);
  });

  test("auth-cookie-must-be-httponly: reports missing httpOnly", () => {
    const code = `
      setCookie("session", token, { secure: true });
    `;
    const messages = lint("jwt-cookies", "auth-cookie-must-be-httponly", code);

    expect(messages.map((m) => m.messageId)).toContain("missingHttpOnly");
  });

  test("auth-cookie-must-be-httponly: allows httpOnly true", () => {
    const code = `
      setCookie("session", token, { httpOnly: true, secure: true });
    `;
    const messages = lint("jwt-cookies", "auth-cookie-must-be-httponly", code);

    expect(messages).toHaveLength(0);
  });

  test("auth-cookie-must-be-secure-in-prod: reports missing secure", () => {
    const code = `
      setCookie("session", token, { httpOnly: true });
    `;
    const messages = lint(
      "jwt-cookies",
      "auth-cookie-must-be-secure-in-prod",
      code
    );

    expect(messages.map((m) => m.messageId)).toContain("missingSecure");
  });

  test("auth-cookie-must-be-secure-in-prod: allows secure true", () => {
    const code = `
      setCookie("session", token, { httpOnly: true, secure: true });
    `;
    const messages = lint(
      "jwt-cookies",
      "auth-cookie-must-be-secure-in-prod",
      code
    );

    expect(messages).toHaveLength(0);
  });

  test("bcrypt-rounds-min: reports rounds below minimum", () => {
    const code = `
      import bcrypt from "bcrypt";
      bcrypt.hash(password, 8);
    `;
    const messages = lint("jwt-cookies", "bcrypt-rounds-min", code);

    expect(messages.map((m) => m.messageId)).toContain("roundsTooLow");
  });

  test("bcrypt-rounds-min: allows rounds at minimum", () => {
    const code = `
      import bcrypt from "bcrypt";
      bcrypt.hash(password, 10);
    `;
    const messages = lint("jwt-cookies", "bcrypt-rounds-min", code);

    expect(messages).toHaveLength(0);
  });

  test("auth-cookie-must-set-samesite: reports missing sameSite", () => {
    const messages = lint(
      "jwt-cookies",
      "auth-cookie-must-set-samesite",
      'setCookie("session", token, { httpOnly: true, secure: true });'
    );

    expect(messages.map((m) => m.messageId)).toContain("missingSameSite");
  });

  test("auth-cookie-must-set-samesite: allows sameSite strict", () => {
    const messages = lint(
      "jwt-cookies",
      "auth-cookie-must-set-samesite",
      'setCookie("session", token, { httpOnly: true, secure: true, sameSite: "strict" });'
    );

    expect(messages).toHaveLength(0);
  });

  test("auth-cookie-must-set-maxage-or-expires: reports missing lifetime", () => {
    const messages = lint(
      "jwt-cookies",
      "auth-cookie-must-set-maxage-or-expires",
      'setCookie("session", token, { httpOnly: true, secure: true, sameSite: "strict" });'
    );

    expect(messages.map((m) => m.messageId)).toContain("missingLifetime");
  });

  test("auth-cookie-must-set-maxage-or-expires: allows maxAge", () => {
    const messages = lint(
      "jwt-cookies",
      "auth-cookie-must-set-maxage-or-expires",
      'setCookie("session", token, { httpOnly: true, secure: true, sameSite: "strict", maxAge: 3600 });'
    );

    expect(messages).toHaveLength(0);
  });

  test("jwt-must-verify-not-decode: reports jwt.decode", () => {
    const messages = lint(
      "jwt-cookies",
      "jwt-must-verify-not-decode",
      "const payload = jwt.decode(token);"
    );

    expect(messages.map((m) => m.messageId)).toContain("useVerifyNotDecode");
  });

  test("jwt-must-verify-not-decode: allows jwt.verify", () => {
    const messages = lint(
      "jwt-cookies",
      "jwt-must-verify-not-decode",
      "const payload = jwt.verify(token, secret);"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("oauth-security pack", () => {
  test("should export oauthSecurityPack with correct structure", () => {
    const pack = RULE_PACKS["oauth-security"];

    expect(pack.id).toBe("oauth-security");
    expect(pack.description).toContain("OAuth");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "pkce-required-for-oidc",
      "state-must-be-redis-backed",
      "state-ttl-bounded",
    ]);
  });

  test("pkce-required-for-oidc: rule exists and is callable", () => {
    const rule = RULE_PACKS["oauth-security"].rules["pkce-required-for-oidc"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("PKCE");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("state-must-be-redis-backed: rule exists and is callable", () => {
    const rule =
      RULE_PACKS["oauth-security"].rules["state-must-be-redis-backed"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("Redis");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("state-ttl-bounded: rule exists and is callable", () => {
    const rule = RULE_PACKS["oauth-security"].rules["state-ttl-bounded"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("TTL");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });
});

describe("tanstack-query pack", () => {
  test("should export tanstackQueryPack with correct structure", () => {
    const pack = RULE_PACKS["tanstack-query"];

    expect(pack.id).toBe("tanstack-query");
    expect(pack.description).toContain("TanStack Query");
    expect(Object.keys(pack.rules)).toEqual([
      "prefix-query-key-must-use-set-queries-data",
    ]);
  });

  test("prefix-query-key-must-use-set-queries-data: rule exists and is callable", () => {
    const rule =
      RULE_PACKS["tanstack-query"].rules[
        "prefix-query-key-must-use-set-queries-data"
      ]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("queryKey");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });
});

describe("i18n-keys pack", () => {
  test("should export i18nKeysPack with correct structure", () => {
    const pack = RULE_PACKS["i18n-keys"];

    expect(pack.id).toBe("i18n-keys");
    expect(pack.description).toContain("Internationalization");
    expect(Object.keys(pack.rules)).toEqual(["static-translation-key-exists"]);
  });

  test("static-translation-key-exists: rule exists and is callable", () => {
    const rule =
      RULE_PACKS["i18n-keys"].rules["static-translation-key-exists"]!;

    expect(rule.meta.type).toBe("problem");
    expect(rule.meta.docs?.description).toContain("Static string");
    expect(rule.meta.messages).toBeDefined();
    expect(rule.meta.schema).toBeDefined();
  });

  test("static-translation-key-exists: reports missing key without dictionary", () => {
    const code = `
      t("missing.key");
    `;
    const messages = lint("i18n-keys", "static-translation-key-exists", code);

    // Rule will report dictionaryReadFailed since no valid dict is provided
    expect(messages.map((m) => m.messageId)).toContain("dictionaryReadFailed");
  });
});

describe("rule-packs: module-boundaries", () => {
  test("no-import-test-from-source: flags source importing a .test file", () => {
    const code = `import { helper } from "../foo.test";`;
    const messages = lint(
      "module-boundaries",
      "no-import-test-from-source",
      code,
      "src/a.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain(
      "testImportedFromSource"
    );
  });

  test("no-import-test-from-source: flags source importing from __tests__", () => {
    const code = `import { helper } from "../__tests__/helpers";`;
    const messages = lint(
      "module-boundaries",
      "no-import-test-from-source",
      code,
      "src/a.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain(
      "testImportedFromSource"
    );
  });

  test("no-import-test-from-source: a test file may import another test file", () => {
    const code = `import { helper } from "../b.test";`;
    const messages = lint(
      "module-boundaries",
      "no-import-test-from-source",
      code,
      "src/a.test.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-import-test-from-source: allows a normal relative source import", () => {
    const code = `import { thing } from "../thing";`;
    const messages = lint(
      "module-boundaries",
      "no-import-test-from-source",
      code,
      "src/a.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-import-build-output: flags importing from dist/", () => {
    const code = `import { x } from "../dist/index";`;
    const messages = lint(
      "module-boundaries",
      "no-import-build-output",
      code,
      "src/a.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("buildOutputImported");
  });

  test("no-import-build-output: flags importing from build/", () => {
    const code = `import { x } from "./build/thing";`;
    const messages = lint(
      "module-boundaries",
      "no-import-build-output",
      code,
      "src/a.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("buildOutputImported");
  });

  test("no-import-build-output: ignores bare package specifiers", () => {
    const code = `import { x } from "some-pkg/dist/lib";`;
    const messages = lint(
      "module-boundaries",
      "no-import-build-output",
      code,
      "src/a.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-import-build-output: allows a normal relative source import", () => {
    const code = `import { thing } from "../lib/thing";`;
    const messages = lint(
      "module-boundaries",
      "no-import-build-output",
      code,
      "src/a.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-react-in-services: reports react import in services/", () => {
    const code = `import { useMemo } from "react";`;
    const messages = lint(
      "module-boundaries",
      "no-react-in-services",
      code,
      "src/services/users.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("reactInService");
  });

  test("no-react-in-services: allows react import in components", () => {
    const code = `import { useState } from "react";`;
    const messages = lint(
      "module-boundaries",
      "no-react-in-services",
      code,
      "src/components/Button.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-react-in-services: reports react-dom in *.queries.ts", () => {
    const code = `import { createPortal } from "react-dom";`;
    const messages = lint(
      "module-boundaries",
      "no-react-in-services",
      code,
      "src/data/users.queries.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("reactInService");
  });
});

describe("rule-packs: nextjs", () => {
  test("client-hooks-require-use-client: flags useState in a server page", () => {
    const code = `import { useState } from "react";
export default function Page() { const [n] = useState(0); return null; }`;
    const messages = lint(
      "nextjs",
      "client-hooks-require-use-client",
      code,
      "app/dashboard/page.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("missingUseClient");
  });

  test("client-hooks-require-use-client: allows hooks with 'use client'", () => {
    const code = `"use client";
import { useState } from "react";
export default function Page() { const [n] = useState(0); return null; }`;
    const messages = lint(
      "nextjs",
      "client-hooks-require-use-client",
      code,
      "app/dashboard/page.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("client-hooks-require-use-client: ignores non-route files", () => {
    const code = `import { useState } from "react";
export function useThing() { return useState(0); }`;
    const messages = lint(
      "nextjs",
      "client-hooks-require-use-client",
      code,
      "app/hooks/use-thing.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-pages-router-data-fetching-in-app: flags getServerSideProps under app/", () => {
    const code = `export async function getServerSideProps() { return { props: {} }; }`;
    const messages = lint(
      "nextjs",
      "no-pages-router-data-fetching-in-app",
      code,
      "app/page.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("pagesDataFnInApp");
  });

  test("no-pages-router-data-fetching-in-app: flags re-exported getStaticProps", () => {
    const code = `const getStaticProps = () => ({ props: {} });
export { getStaticProps };`;
    const messages = lint(
      "nextjs",
      "no-pages-router-data-fetching-in-app",
      code,
      "app/page.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("pagesDataFnInApp");
  });

  test("no-pages-router-data-fetching-in-app: ignores files outside app/", () => {
    const code = `export async function getServerSideProps() { return { props: {} }; }`;
    const messages = lint(
      "nextjs",
      "no-pages-router-data-fetching-in-app",
      code,
      "pages/index.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-next-head-in-app: flags next/head import under app/", () => {
    const code = `import Head from "next/head";`;
    const messages = lint("nextjs", "no-next-head-in-app", code, "app/page.ts");

    expect(messages.map((m) => m.messageId)).toContain("nextHeadInApp");
  });

  test("no-next-head-in-app: ignores next/head outside app/", () => {
    const code = `import Head from "next/head";`;
    const messages = lint(
      "nextjs",
      "no-next-head-in-app",
      code,
      "pages/index.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-internal-api-fetch: reports fetch to /api in server page", () => {
    const code = `export default async function Page() {
  const res = await fetch("/api/users");
  return null;
}`;
    const messages = lint(
      "nextjs",
      "no-internal-api-fetch",
      code,
      "app/dashboard/page.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("internalApiFetch");
  });

  test("no-internal-api-fetch: allows fetch in use client file", () => {
    const code = `"use client";
export default function Page() {
  fetch("/api/users");
  return null;
}`;
    const messages = lint(
      "nextjs",
      "no-internal-api-fetch",
      code,
      "app/dashboard/page.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("await-dynamic-request-apis: reports bare cookies()", () => {
    const code = `import { cookies } from "next/headers";
export default async function Page() {
  const jar = cookies();
  return null;
}`;
    const messages = lint(
      "nextjs",
      "await-dynamic-request-apis",
      code,
      "app/page.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("mustAwait");
  });

  test("await-dynamic-request-apis: allows await cookies()", () => {
    const code = `import { cookies } from "next/headers";
export default async function Page() {
  const jar = await cookies();
  return null;
}`;
    const messages = lint(
      "nextjs",
      "await-dynamic-request-apis",
      code,
      "app/page.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("error-boundary-require-use-client: reports missing directive", () => {
    const code = `export default function Error({ error }: { error: Error }) {
  return <div>{error.message}</div>;
}`;
    const messages = lint(
      "nextjs",
      "error-boundary-require-use-client",
      code,
      "app/dashboard/error.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("missingUseClient");
  });

  test("error-boundary-require-use-client: allows use client", () => {
    const code = `"use client";
export default function Error({ error }: { error: Error }) {
  return <div>{error.message}</div>;
}`;
    const messages = lint(
      "nextjs",
      "error-boundary-require-use-client",
      code,
      "app/dashboard/error.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-html-img-element: reports img tag", () => {
    const code = `export function Hero() { return <img src="/hero.jpg" alt="hero" />; }`;
    const messages = lint(
      "nextjs",
      "no-html-img-element",
      code,
      "src/components/Hero.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("useNextImage");
  });

  test("no-sensitive-next-public-env: reports NEXT_PUBLIC with SECRET", () => {
    const code = `const key = process.env.NEXT_PUBLIC_STRIPE_SECRET;`;
    const messages = lint(
      "nextjs",
      "no-sensitive-next-public-env",
      code,
      "src/config.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("sensitiveNextPublic");
  });

  test("prefer-lazy-use-state-init: reports eager localStorage parse", () => {
    const code = `"use client";
import { useState } from "react";
export function Panel() {
  const [config] = useState(JSON.parse(localStorage.getItem("cfg") ?? "{}"));
  return null;
}`;
    const messages = lint(
      "nextjs",
      "prefer-lazy-use-state-init",
      code,
      "src/Panel.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("preferLazyInit");
  });

  test("prefer-lazy-use-state-init: allows lazy initializer", () => {
    const code = `"use client";
import { useState } from "react";
export function Panel() {
  const [config] = useState(() => JSON.parse(localStorage.getItem("cfg") ?? "{}"));
  return null;
}`;
    const messages = lint(
      "nextjs",
      "prefer-lazy-use-state-init",
      code,
      "src/Panel.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("server-only-modules-import-server-only: reports missing import", () => {
    const messages = lint(
      "nextjs",
      "server-only-modules-import-server-only",
      "export default async function Page() { return null; }",
      "app/dashboard/page.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain(
      "missingServerOnlyImport"
    );
  });

  test("server-only-modules-import-server-only: allows server-only import", () => {
    const messages = lint(
      "nextjs",
      "server-only-modules-import-server-only",
      'import "server-only";\nexport default async function Page() { return null; }',
      "app/dashboard/page.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-secret-props-to-client: reports secret prop", () => {
    const messages = lint(
      "nextjs",
      "no-secret-props-to-client",
      "export default function Page() { return <Panel apiKey={key} />; }",
      "app/dashboard/page.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("secretPropToClient");
  });

  test("server-action-requires-authz-and-validation: reports missing authz and parse", () => {
    const messages = lint(
      "nextjs",
      "server-action-requires-authz-and-validation",
      `"use server";\nexport async function save(data) { await db.insert(users).values(data); }`
    );

    expect(messages.map((m) => m.messageId)).toContain("missingAuthz");
    expect(messages.map((m) => m.messageId)).toContain("missingValidation");
  });

  test("server-action-requires-authz-and-validation: allows authz and parse", () => {
    const messages = lint(
      "nextjs",
      "server-action-requires-authz-and-validation",
      `"use server";\nexport async function save(data) { requireUser(); const parsed = schema.parse(data); await db.insert(users).values(parsed); }`
    );

    expect(messages).toHaveLength(0);
  });

  test("mutation-should-revalidate-cache: reports missing revalidation", () => {
    const messages = lint(
      "nextjs",
      "mutation-should-revalidate-cache",
      `"use server";\nexport async function save(data) { await db.insert(users).values(data); }`
    );

    expect(messages.map((m) => m.messageId)).toContain("missingRevalidation");
  });

  test("mutation-should-revalidate-cache: allows revalidatePath", () => {
    const messages = lint(
      "nextjs",
      "mutation-should-revalidate-cache",
      `"use server";\nimport { revalidatePath } from "next/cache";\nexport async function save(data) { await db.insert(users).values(data); revalidatePath("/users"); }`
    );

    expect(messages).toHaveLength(0);
  });
});

describe("code-flow: no-throw-literal", () => {
  test("reports throw string literal", () => {
    const messages = lint(
      "code-flow",
      "no-throw-literal",
      "throw 'Unauthorized';",
      "src/auth.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("throwLiteral");
  });

  test("allows throw new Error", () => {
    const messages = lint(
      "code-flow",
      "no-throw-literal",
      "throw new Error('Unauthorized');",
      "src/auth.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("fastify pack", () => {
  test("require-route-schema: reports POST without schema.body", () => {
    const code = `
import Fastify from "fastify";
const fastify = Fastify();
fastify.post("/users", { schema: {} }, async () => ({ ok: true }));
`;
    const messages = lint(
      "fastify",
      "require-route-schema",
      code,
      "src/routes/users.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("missingBodySchema");
  });

  test("require-route-schema: allows POST with schema.body", () => {
    const code = `
import Fastify from "fastify";
const UserSchema = {};
const fastify = Fastify();
fastify.post("/users", { schema: { body: UserSchema } }, async () => ({ ok: true }));
`;
    const messages = lint(
      "fastify",
      "require-route-schema",
      code,
      "src/routes/users.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("require-fastify-plugin-name: reports fp without name", () => {
    const code = `
import fp from "fastify-plugin";
export default fp(async function dbPlugin(fastify) {
  fastify.decorate("db", {});
});
`;
    const messages = lint(
      "fastify",
      "require-fastify-plugin-name",
      code,
      "src/plugins/db.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("missingPluginName");
  });

  test("require-fastify-plugin-name: allows fp with name", () => {
    const code = `
import fp from "fastify-plugin";
export default fp(async function dbPlugin(fastify) {
  fastify.decorate("db", {});
}, { name: "db-connector" });
`;
    const messages = lint(
      "fastify",
      "require-fastify-plugin-name",
      code,
      "src/plugins/db.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("test-inject-must-close-app: reports inject without close", () => {
    const code = `
import { test } from "node:test";
import { buildApp } from "./app";
test("login", async () => {
  const app = buildApp();
  await app.inject({ method: "GET", url: "/health" });
});
`;
    const messages = lint(
      "fastify",
      "test-inject-must-close-app",
      code,
      "src/routes/users.test.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("missingAppClose");
  });

  test("test-inject-must-close-app: allows inject with close", () => {
    const code = `
import { test } from "node:test";
import { buildApp } from "./app";
test("login", async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  await app.inject({ method: "GET", url: "/health" });
});
`;
    const messages = lint(
      "fastify",
      "test-inject-must-close-app",
      code,
      "src/routes/users.test.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("security pack", () => {
  test("should export securityPack with correct structure", () => {
    const pack = RULE_PACKS.security;

    expect(pack.id).toBe("security");
    expect(pack.description).toContain("security");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "catch-must-handle",
      "no-auth-token-in-storage",
      "no-child-process-exec",
      "no-dynamic-regexp",
      "no-inner-html-assignment",
      "no-spawn-with-shell",
    ]);
    expect(pack.rulesConfig["no-child-process-exec"]).toBe("error");
  });

  test("no-child-process-exec: reports child_process.exec", () => {
    const code = `import * as child_process from "child_process";
child_process.exec("rm -rf /");`;
    const messages = lint(
      "security",
      "no-child-process-exec",
      code,
      "src/runner.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("noExec");
  });

  test("no-child-process-exec: allows execFile", () => {
    const code = `import { execFile } from "child_process";
execFile("ls", ["-la"], () => {});`;
    const messages = lint(
      "security",
      "no-child-process-exec",
      code,
      "src/runner.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-spawn-with-shell: reports spawn with shell true", () => {
    const code = `import { spawn } from "child_process";
spawn("sh", ["-c", cmd], { shell: true });`;
    const messages = lint(
      "security",
      "no-spawn-with-shell",
      code,
      "src/runner.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("spawnWithShell");
  });

  test("no-spawn-with-shell: allows spawn without shell", () => {
    const code = `import { spawn } from "child_process";
spawn("node", ["script.js"]);`;
    const messages = lint(
      "security",
      "no-spawn-with-shell",
      code,
      "src/runner.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-dynamic-regexp: reports RegExp from variable", () => {
    const code = `const pattern = userInput;
const re = new RegExp(pattern);`;
    const messages = lint(
      "security",
      "no-dynamic-regexp",
      code,
      "src/validate.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("dynamicRegexp");
  });

  test("no-dynamic-regexp: allows string literal pattern", () => {
    const code = `const re = new RegExp("^foo$");`;
    const messages = lint(
      "security",
      "no-dynamic-regexp",
      code,
      "src/validate.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-inner-html-assignment: reports innerHTML assignment", () => {
    const code = `const el = document.getElementById("x");
el.innerHTML = userHtml;`;
    const messages = lint(
      "security",
      "no-inner-html-assignment",
      code,
      "src/dom.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("innerHtmlAssignment");
  });

  test("catch-must-handle: reports silent return null", () => {
    const code = `try { doWork(); } catch (e) { return null; }`;
    const messages = lint(
      "security",
      "catch-must-handle",
      code,
      "src/worker.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("silentCatch");
  });

  test("catch-must-handle: allows console.error in catch", () => {
    const code = `try { doWork(); } catch (e) { console.error(e); return null; }`;
    const messages = lint(
      "security",
      "catch-must-handle",
      code,
      "src/worker.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-auth-token-in-storage: reports localStorage.setItem session key", () => {
    const code = `localStorage.setItem("auth_token", token);`;
    const messages = lint(
      "security",
      "no-auth-token-in-storage",
      code,
      "src/auth.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("authTokenInStorage");
  });

  test("no-auth-token-in-storage: allows unrelated storage keys", () => {
    const code = `localStorage.setItem("theme", "dark");`;
    const messages = lint(
      "security",
      "no-auth-token-in-storage",
      code,
      "src/ui.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("react-component-architecture: new rules", () => {
  test("no-react-fc: reports React.FC", () => {
    const code = `type IProps = { label: string };
const Badge: React.FC<IProps> = ({ label }) => <span>{label}</span>;`;
    const messages = lint(
      "react-component-architecture",
      "no-react-fc",
      code,
      "src/components/Badge.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("noReactFc");
  });

  test("no-component-invocation: reports Header()", () => {
    const code = `function Header() { return <header />; }
export function App() { return <div>{Header()}</div>; }`;
    const messages = lint(
      "react-component-architecture",
      "no-component-invocation",
      code,
      "src/App.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("componentInvocation");
  });

  test("dangerous-html-requires-sanitize: reports without import", () => {
    const code = `export function Page({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}`;
    const messages = lint(
      "react-component-architecture",
      "dangerous-html-requires-sanitize",
      code,
      "src/Page.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("missingSanitize");
  });

  test("dangerous-html-requires-sanitize: allows with dompurify import", () => {
    const code = `import DOMPurify from "isomorphic-dompurify";
export function Page({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />;
}`;
    const messages = lint(
      "react-component-architecture",
      "dangerous-html-requires-sanitize",
      code,
      "src/Page.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-anonymous-useEffect: reports arrow callback", () => {
    const code = `import { useEffect } from "react";
export function Page() {
  useEffect(() => { document.title = "x"; }, []);
  return null;
}`;
    const messages = lint(
      "react-component-architecture",
      "no-anonymous-useEffect",
      code,
      "src/Page.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("anonymousEffect");
  });

  test("no-anonymous-useEffect: allows named function callback", () => {
    const code = `import { useEffect } from "react";
export function Page() {
  useEffect(function syncTitle() { document.title = "x"; }, []);
  return null;
}`;
    const messages = lint(
      "react-component-architecture",
      "no-anonymous-useEffect",
      code,
      "src/Page.tsx"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-derived-state-in-effect: reports setter only in useEffect", () => {
    const code = `import { useEffect, useState } from "react";
export function Counter({ seed }: { seed: number }) {
  const [count, setCount] = useState(0);
  useEffect(() => { setCount(seed); }, [seed]);
  return <span>{count}</span>;
}`;
    const messages = lint(
      "react-component-architecture",
      "no-derived-state-in-effect",
      code,
      "src/Counter.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("derivedStateInEffect");
  });

  test("no-derived-state-in-effect: allows setter outside useEffect", () => {
    const code = `import { useState } from "react";
export function Counter() {
  const [count, setCount] = useState(0);
  function increment() { setCount((c) => c + 1); }
  return <button onClick={increment}>{count}</button>;
}`;
    const messages = lint(
      "react-component-architecture",
      "no-derived-state-in-effect",
      code,
      "src/Counter.tsx"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("runtime-boundaries pack", () => {
  test("should export runtimeBoundariesPack with correct structure", () => {
    const pack = RULE_PACKS["runtime-boundaries"];

    expect(pack.id).toBe("runtime-boundaries");
    expect(pack.description).toContain("boundary");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "no-prototype-polluting-merge",
      "no-user-controlled-fetch-url",
      "no-user-controlled-redirect",
      "upload-must-set-limits",
      "webhook-must-verify-signature-before-parse",
    ]);
    expect(pack.rulesConfig["no-user-controlled-redirect"]).toBe("error");
    expect(pack.rulesConfig["webhook-must-verify-signature-before-parse"]).toBe(
      "warn"
    );
  });

  test("no-user-controlled-redirect: reports dynamic redirect URL", () => {
    const code = `import { redirect } from "next/navigation";
export function go(target: string) { redirect(target); }`;
    const messages = lint(
      "runtime-boundaries",
      "no-user-controlled-redirect",
      code,
      "src/actions.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain(
      "userControlledRedirect"
    );
  });

  test("no-user-controlled-redirect: allows literal redirect URL", () => {
    const code = `import { redirect } from "next/navigation";
export function go() { redirect("/dashboard"); }`;
    const messages = lint(
      "runtime-boundaries",
      "no-user-controlled-redirect",
      code,
      "src/actions.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-user-controlled-fetch-url: reports dynamic fetch URL", () => {
    const code = `export async function load(url: string) { return fetch(url); }`;
    const messages = lint(
      "runtime-boundaries",
      "no-user-controlled-fetch-url",
      code,
      "src/client.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain(
      "userControlledFetchUrl"
    );
  });

  test("no-user-controlled-fetch-url: allows literal fetch URL", () => {
    const code = `export async function load() { return fetch("https://api.example.com"); }`;
    const messages = lint(
      "runtime-boundaries",
      "no-user-controlled-fetch-url",
      code,
      "src/client.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test.each([
    ["`/api/todos/${id}`", "a relative path with an interpolated segment"],
    ["`api/todos/${id}`", "a relative path without a leading slash"],
    ["`https://api.example.com/v1/${id}`", "a fixed host, interpolated path"],
    ["`https://api.example.com/?q=${q}`", "a fixed host, interpolated query"],
    [
      "`https://api.example.com/#${frag}`",
      "a fixed host, interpolated fragment",
    ],
    ["`/api/todos`", "a template with no interpolation at all"],
  ])("no-user-controlled-fetch-url: ALLOWS %s (%s)", (url) => {
    // SSRF is control of the HOST. These cannot reach another origin however
    // hostile the interpolated value is, and forbidding them made an ordinary
    // resource-by-id client impossible to write.
    const code = `export async function load(id: string, q: string, frag: string) { return fetch(${url}); }`;
    const messages = lint(
      "runtime-boundaries",
      "no-user-controlled-fetch-url",
      code,
      "src/client.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test.each([
    ["url", "a bare identifier"],
    ["`${base}/api/todos`", "an empty first quasi — the whole URL is runtime"],
    ["`https://${host}/todos`", "an expression in the host position"],
    ["`//${host}/todos`", "protocol-relative with a runtime host"],
    [
      "`https://api.example.com${path}`",
      "an unterminated authority — `@evil.com/x` rewrites the host via userinfo",
    ],
    [
      "`https://api.example.com:${port}`",
      "an unterminated authority in the port position",
    ],
  ])("no-user-controlled-fetch-url: FLAGS %s (%s)", (url) => {
    const code = `export async function load(url: string, base: string, host: string, path: string, port: string) { return fetch(${url}); }`;
    const messages = lint(
      "runtime-boundaries",
      "no-user-controlled-fetch-url",
      code,
      "src/client.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain(
      "userControlledFetchUrl"
    );
  });

  test("no-user-controlled-fetch-url: the origin rule applies to axios too", () => {
    const ok = lint(
      "runtime-boundaries",
      "no-user-controlled-fetch-url",
      "export const go = (id: string) => axios.get(`/api/todos/${id}`);",
      "src/client.ts"
    );

    expect(ok).toHaveLength(0);

    const bad = lint(
      "runtime-boundaries",
      "no-user-controlled-fetch-url",
      "export const go = (h: string) => axios.get(`https://${h}/todos`);",
      "src/client.ts"
    );

    expect(bad.map((m) => m.messageId)).toContain("userControlledFetchUrl");
  });

  test("no-prototype-polluting-merge: reports Object.assign with req.body", () => {
    const code = `export function merge(req: { body: object }, target: object) {
  return Object.assign(target, req.body);
}`;
    const messages = lint(
      "runtime-boundaries",
      "no-prototype-polluting-merge",
      code,
      "src/handler.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain(
      "prototypePollutingMerge"
    );
  });

  test("no-prototype-polluting-merge: reports spread of query", () => {
    const code = `export function copy(query: object) { return { ...query }; }`;
    const messages = lint(
      "runtime-boundaries",
      "no-prototype-polluting-merge",
      code,
      "src/handler.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain(
      "prototypePollutingMerge"
    );
  });

  test("webhook-must-verify-signature-before-parse: reports json before verify", () => {
    const code = `export async function handleWebhook(request: Request) {
  const payload = await request.json();
  verifySignature(payload);
}`;
    const messages = lint(
      "runtime-boundaries",
      "webhook-must-verify-signature-before-parse",
      code,
      "src/routes/stripe-webhook.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("jsonBeforeVerify");
  });

  test("webhook-must-verify-signature-before-parse: allows verify before json", () => {
    const code = `export async function handleWebhook(request: Request) {
  verifySignature(request);
  const payload = await request.json();
  return payload;
}`;
    const messages = lint(
      "runtime-boundaries",
      "webhook-must-verify-signature-before-parse",
      code,
      "src/routes/stripe-webhook.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("upload-must-set-limits: reports multipart handler without limits", () => {
    const code = `import multipart from "@fastify/multipart";
export async function handleUpload(request: { file: () => Promise<unknown> }) {
  return request.file();
}`;
    const messages = lint(
      "runtime-boundaries",
      "upload-must-set-limits",
      code,
      "src/routes/upload.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("missingUploadLimits");
  });

  test("upload-must-set-limits: allows multipart handler with limits", () => {
    const code = `import multipart from "@fastify/multipart";
const limits = { fileSize: 1024 };
export async function handleUpload(request: { file: () => Promise<unknown> }) {
  return request.file();
}`;
    const messages = lint(
      "runtime-boundaries",
      "upload-must-set-limits",
      code,
      "src/routes/upload.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("ai-sdk pack", () => {
  test("should export aiSdkPack with correct structure", () => {
    const pack = RULE_PACKS["ai-sdk"];

    expect(pack.id).toBe("ai-sdk");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "no-api-key-in-client",
      "no-user-input-in-system-prompt",
      "require-completion-token-limit",
    ]);
    expect(pack.rulesConfig["no-api-key-in-client"]).toBe("error");
    expect(pack.rulesConfig["require-completion-token-limit"]).toBe("error");
    expect(pack.rulesConfig["no-user-input-in-system-prompt"]).toBe("warn");
  });

  test("no-api-key-in-client: flags `new OpenAI()` in a client component", () => {
    const code = `"use client";
import OpenAI from "openai";
const client = new OpenAI({ apiKey: "sk-x" });
export function Chat() {
  return client;
}`;
    const messages = lint(
      "ai-sdk",
      "no-api-key-in-client",
      code,
      "src/chat.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("clientProvider");
  });

  test("no-api-key-in-client: flags a provider factory in a client component", () => {
    const code = `"use client";
import { createOpenAI } from "@ai-sdk/openai";
const openai = createOpenAI({ apiKey: "sk-x" });
export function Chat() {
  return openai;
}`;
    const messages = lint(
      "ai-sdk",
      "no-api-key-in-client",
      code,
      "src/chat.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("clientProvider");
  });

  test("no-api-key-in-client: allows provider construction on the server", () => {
    const code = `import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.KEY });
export function getClient() {
  return client;
}`;
    const messages = lint(
      "ai-sdk",
      "no-api-key-in-client",
      code,
      "src/server/ai.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("require-completion-token-limit: flags generateText without maxTokens", () => {
    const code = `import { generateText } from "ai";
export async function run(model: unknown) {
  return generateText({ model, prompt: "hi" });
}`;
    const messages = lint(
      "ai-sdk",
      "require-completion-token-limit",
      code,
      "src/server/run.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("missingLimit");
  });

  test("require-completion-token-limit: flags openai create() without max_tokens", () => {
    const code = `export async function run(openai: { chat: { completions: { create: (o: unknown) => Promise<unknown> } } }) {
  return openai.chat.completions.create({ model: "gpt-4o", messages: [] });
}`;
    const messages = lint(
      "ai-sdk",
      "require-completion-token-limit",
      code,
      "src/server/run.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("missingLimit");
  });

  test("require-completion-token-limit: allows a bounded call", () => {
    const code = `import { generateText } from "ai";
export async function run(model: unknown) {
  return generateText({ model, prompt: "hi", maxTokens: 256 });
}`;
    const messages = lint(
      "ai-sdk",
      "require-completion-token-limit",
      code,
      "src/server/run.ts"
    );

    expect(messages).toHaveLength(0);
  });

  test("no-user-input-in-system-prompt: warns on an interpolated system field", () => {
    const code = `import { generateText } from "ai";
export async function run(model: unknown, role: string) {
  return generateText({ model, system: \`You are a \${role}.\`, prompt: "hi" });
}`;
    const messages = lint(
      "ai-sdk",
      "no-user-input-in-system-prompt",
      code,
      "src/server/run.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("dynamicSystemPrompt");
  });

  test("no-user-input-in-system-prompt: warns on concatenated system message content", () => {
    const code = `export function build(userInput: string) {
  return [{ role: "system", content: "Base. " + userInput }];
}`;
    const messages = lint(
      "ai-sdk",
      "no-user-input-in-system-prompt",
      code,
      "src/server/run.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("dynamicSystemPrompt");
  });

  test("no-user-input-in-system-prompt: allows a constant system prompt", () => {
    const code = `import { generateText } from "ai";
export async function run(model: unknown) {
  return generateText({ model, system: "You are a helpful assistant.", prompt: "hi" });
}`;
    const messages = lint(
      "ai-sdk",
      "no-user-input-in-system-prompt",
      code,
      "src/server/run.ts"
    );

    expect(messages).toHaveLength(0);
  });
});

describe("react-component-architecture: no-jsx-computation (narrowed)", () => {
  test("ALLOWS a simple non-chained list-render .map() in JSX", () => {
    const code =
      "export const List = ({ items }: { items: number[] }) => (\n" +
      "  <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>\n" +
      ");\n";
    const messages = lint(
      "react-component-architecture",
      "no-jsx-computation",
      code,
      "src/views/List.tsx"
    );

    expect(messages.map((m) => m.messageId)).not.toContain("noComputation");
  });

  test("FLAGS a chained .filter().map() in JSX", () => {
    const code =
      "export const List = ({ items }: { items: { on: boolean }[] }) => (\n" +
      "  <ul>{items.filter((i) => i.on).map((i) => <li />)}</ul>\n" +
      ");\n";
    const messages = lint(
      "react-component-architecture",
      "no-jsx-computation",
      code,
      "src/views/List.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("noComputation");
  });

  test("FLAGS a bare .filter()/.reduce() and arithmetic in JSX", () => {
    const filter = lint(
      "react-component-architecture",
      "no-jsx-computation",
      "export const V = ({ xs }: { xs: number[] }) => <div>{xs.filter((x) => x > 0)}</div>;\n",
      "src/views/V.tsx"
    );
    const arith = lint(
      "react-component-architecture",
      "no-jsx-computation",
      "export const V = ({ a, b }: { a: number; b: number }) => <div>{a + b}</div>;\n",
      "src/views/V.tsx"
    );

    expect(filter.map((m) => m.messageId)).toContain("noComputation");
    expect(arith.map((m) => m.messageId)).toContain("noComputation");
  });
});

describe("react-component-architecture: promoted severities", () => {
  test("genuine-smell rules are gate-blocking errors", () => {
    const cfg = RULE_PACKS["react-component-architecture"].rulesConfig;

    expect(cfg["max-hooks-per-file"]).toBe("error");
    expect(cfg["no-anonymous-useEffect"]).toBe("error");
    expect(cfg["no-derived-state-in-effect"]).toBe("error");
  });

  test("no-inline-jsx-functions stays advisory (idiomatic inline handlers)", () => {
    const cfg = RULE_PACKS["react-component-architecture"].rulesConfig;

    expect(cfg["no-inline-jsx-functions"]).toBe("warn");
  });
});

describe("typescript-core: no-self-import", () => {
  test("FLAGS a file importing its own export from itself", () => {
    const messages = lint(
      "typescript-core",
      "no-self-import",
      'import { DashboardContent } from "./DashboardContent";\nexport function DashboardContent() { return null; }\n',
      "src/views/Dashboard/DashboardContent.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("selfImport");
  });

  test("FLAGS a barrel re-exporting from '.' (index importing itself)", () => {
    const messages = lint(
      "typescript-core",
      "no-self-import",
      'export { Foo } from ".";\n',
      "src/features/foo/index.tsx"
    );

    expect(messages.map((m) => m.messageId)).toContain("selfImport");
  });

  test("ALLOWS importing a DIFFERENT sibling module", () => {
    const messages = lint(
      "typescript-core",
      "no-self-import",
      'import { Other } from "./Other";\nexport function DashboardContent() { return Other; }\n',
      "src/views/Dashboard/DashboardContent.tsx"
    );

    expect(messages.map((m) => m.messageId)).not.toContain("selfImport");
  });

  // The exact shape that stalled the hospital-scheduling web build: a barrel
  // `index.ts` re-exporting from "./index" — which resolves to the barrel ITSELF
  // (the real component sat beside it in `index.tsx`). tsc resolves `./index` to
  // the .tsx and typechecks fine, but Rollup resolves it to the .ts and fails
  // with a cryptic "reexports itself" — a contradiction the model couldn't fix.
  // Lint must catch it up front with the actionable message.
  test("FLAGS a barrel index.ts re-exporting from './index' (self)", () => {
    const messages = lint(
      "typescript-core",
      "no-self-import",
      'export { AppointmentsList } from "./index";\n',
      "src/views/Appointments/index.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("selfImport");
  });
});

describe("typescript-core: fetch-must-check-ok", () => {
  test("reports a bound response parsed without a check", () => {
    const messages = lint(
      "typescript-core",
      "fetch-must-check-ok",
      'async function load() { const res = await fetch("/api/users"); return res.json(); }'
    );

    expect(messages.map((m) => m.messageId)).toContain("missingOkCheck");
  });

  test("reports an inline parse with no binding at all", () => {
    const messages = lint(
      "typescript-core",
      "fetch-must-check-ok",
      'async function load() { return (await fetch("/api/users")).json(); }'
    );

    expect(messages.map((m) => m.messageId)).toContain("missingOkCheck");
  });

  test("reports a then-callback that parses without a check", () => {
    const messages = lint(
      "typescript-core",
      "fetch-must-check-ok",
      'const data = fetch("/api/users").then((res) => res.json());'
    );

    expect(messages.map((m) => m.messageId)).toContain("missingOkCheck");
  });

  test("allows a guard clause on res.ok", () => {
    const messages = lint(
      "typescript-core",
      "fetch-must-check-ok",
      'async function load() { const res = await fetch("/api/users"); if (!res.ok) { throw new Error("failed"); } return res.json(); }'
    );

    expect(messages).toHaveLength(0);
  });

  test("allows a status comparison instead of ok", () => {
    const messages = lint(
      "typescript-core",
      "fetch-must-check-ok",
      'async function load() { const res = await fetch("/api/users"); if (res.status !== 200) { return null; } return res.json(); }'
    );

    expect(messages).toHaveLength(0);
  });

  test("allows a then-callback that checks ok", () => {
    const messages = lint(
      "typescript-core",
      "fetch-must-check-ok",
      'const data = fetch("/api/users").then((res) => (res.ok ? res.json() : null));'
    );

    expect(messages).toHaveLength(0);
  });

  test("reports a check that only happens after the body is parsed", () => {
    const messages = lint(
      "typescript-core",
      "fetch-must-check-ok",
      'async function load() { const res = await fetch("/api/users"); const data = await res.json(); if (!res.ok) { throw new Error("failed"); } return data; }'
    );

    expect(messages.map((m) => m.messageId)).toContain("missingOkCheck");
  });

  test("reports a status read that is recorded rather than acted on", () => {
    const messages = lint(
      "typescript-core",
      "fetch-must-check-ok",
      'async function load() { const res = await fetch("/api/users"); metrics.observe(res.status); return res.json(); }'
    );

    expect(messages.map((m) => m.messageId)).toContain("missingOkCheck");
  });

  test("reports an ok read bound to a variable and never tested", () => {
    const messages = lint(
      "typescript-core",
      "fetch-must-check-ok",
      'async function load() { const res = await fetch("/api/users"); const ok = res.ok; log(ok); return res.json(); }'
    );

    expect(messages.map((m) => m.messageId)).toContain("missingOkCheck");
  });

  test("allows an ok read bound to a variable and then tested", () => {
    const messages = lint(
      "typescript-core",
      "fetch-must-check-ok",
      'async function load() { const res = await fetch("/api/users"); const ok = res.ok; if (!ok) { throw new Error("failed"); } return res.json(); }'
    );

    expect(messages).toHaveLength(0);
  });

  test("allows an assertion helper as the check", () => {
    const messages = lint(
      "typescript-core",
      "fetch-must-check-ok",
      'async function load() { const res = await fetch("/api/users"); invariant(res.ok, "failed"); return res.json(); }'
    );

    expect(messages).toHaveLength(0);
  });

  test("reports a then-callback that parses before it checks", () => {
    const messages = lint(
      "typescript-core",
      "fetch-must-check-ok",
      'const data = fetch("/api/users").then((res) => { const body = res.json(); if (!res.ok) { throw new Error("failed"); } return body; });'
    );

    expect(messages.map((m) => m.messageId)).toContain("missingOkCheck");
  });

  test("ignores a response whose body is never parsed", () => {
    const messages = lint(
      "typescript-core",
      "fetch-must-check-ok",
      'async function ping() { const res = await fetch("/api/health"); return res.text(); }'
    );

    expect(messages).toHaveLength(0);
  });
});
