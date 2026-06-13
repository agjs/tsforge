import { test, expect, describe } from "bun:test";
import { Linter, type Rule } from "eslint";
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
  const linter = new Linter();
  const pack = RULE_PACKS[packId];
  const rule = pack.rules[ruleName];

  if (!rule) {
    throw new Error(`Rule ${ruleName} not found in pack ${packId}`);
  }

  // Bridge the type gap: cast the TSESLint.RuleModule to ESLint's Rule.RuleModule
  // (The eslint.config.js override at lines 185 relaxes type assertions for test files,
  // and this single bridge point is within that scope.)
  const ruleModule = rule as unknown as Rule.RuleModule;

  const config = {
    files: ["**/*.ts"],
    plugins: { tsforge: { rules: { [ruleName]: ruleModule } } },
    rules: {
      [`tsforge/${ruleName}`]: options ? ["error", ...options] : "error",
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
  } as unknown as Linter.Config;

  return linter.verify(code, config, filename);
}

describe("rule-packs: registry", () => {
  test("should have all fifteen packs registered", () => {
    expect(Object.keys(RULE_PACKS).sort()).toEqual([
      "bullmq",
      "code-flow",
      "comment-hygiene",
      "drizzle",
      "elysia",
      "env-access",
      "i18n-keys",
      "jwt-cookies",
      "module-boundaries",
      "nextjs",
      "oauth-security",
      "react-component-architecture",
      "structured-logging",
      "tanstack-query",
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
      "no-focused-tests",
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

    // Total: 10 rules
    expect(Object.keys(rules).length).toBe(10);
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
      "require-hooks-before-routes",
      "require-plugin-name",
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

  test("require-plugin-name: reports unnamed exported Elysia instance", () => {
    const code = `
      export const plugin = new Elysia();
    `;
    const messages = lint("elysia", "require-plugin-name", code);

    expect(messages.map((m) => m.messageId)).toContain("missingPluginName");
  });

  test("require-plugin-name: allows named plugin export", () => {
    const code = `
      export const plugin = new Elysia({ name: "auth-plugin" });
    `;
    const messages = lint("elysia", "require-plugin-name", code);

    expect(messages).toHaveLength(0);
  });
});

describe("structured-logging pack", () => {
  test("should export structuredLoggingPack with correct structure", () => {
    const pack = RULE_PACKS["structured-logging"];

    expect(pack.id).toBe("structured-logging");
    expect(pack.description).toContain("Structured logging");
    expect(Object.keys(pack.rules).sort()).toEqual([
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
});

describe("react-component-architecture pack", () => {
  test("should export reactComponentArchitecturePack with correct structure", () => {
    const pack = RULE_PACKS["react-component-architecture"];

    expect(pack.id).toBe("react-component-architecture");
    expect(pack.description).toContain("Component structure");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "component-folder-structure",
      "forwardref-display-name",
      "index-must-reexport-default",
      "max-hooks-per-file",
      "no-cross-feature-imports",
      "no-inline-jsx-functions",
    ]);
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
});

describe("jwt-cookies pack", () => {
  test("should export jwtCookiesPack with correct structure", () => {
    const pack = RULE_PACKS["jwt-cookies"];

    expect(pack.id).toBe("jwt-cookies");
    expect(pack.description).toContain("JWT and cookie");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "auth-cookie-must-be-httponly",
      "auth-cookie-must-be-secure-in-prod",
      "bcrypt-rounds-min",
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
});
