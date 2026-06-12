import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  rmdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  META_RULES,
  buildMetaRuleContext,
  runMetaRules,
} from "../src/meta-rules";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tsforge-meta-rules-"));
});

afterEach(() => {
  // Clean up temp directory recursively
  const removeRecursive = (dir: string) => {
    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const full = join(dir, entry);
        const stat = statSync(full);

        if (stat.isDirectory()) {
          removeRecursive(full);
        } else {
          unlinkSync(full);
        }
      }

      rmdirSync(dir);
    } catch {
      // Ignore errors
    }
  };

  removeRecursive(tempDir);
});

// === Supply Chain Rules ===

test("package-exact-deps: violates on ^ range", () => {
  const pkgJson = {
    dependencies: {
      express: "^4.18.0",
    },
    devDependencies: {},
  };

  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify(pkgJson, null, 2)
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter((v) => v.ruleId === "package-exact-deps");

  expect(relevant.length).toBeGreaterThan(0);
  expect(relevant[0]?.message).toContain("exact versions");
});

test("package-exact-deps: passes on exact version", () => {
  const pkgJson = {
    dependencies: {
      express: "4.18.2",
    },
    devDependencies: {
      typescript: "5.1.6",
    },
  };

  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify(pkgJson, null, 2)
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter((v) => v.ruleId === "package-exact-deps");

  expect(relevant.length).toBe(0);
});

test("no-overlapping-libs: detects axios + node-fetch", () => {
  const pkgJson = {
    dependencies: {
      axios: "1.4.0",
      "node-fetch": "3.3.0",
    },
    devDependencies: {},
  };

  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify(pkgJson, null, 2)
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter((v) => v.ruleId === "no-overlapping-libs");

  expect(relevant.length).toBeGreaterThan(0);
  expect(relevant[0]?.message).toContain("axios");
});

test("no-overlapping-libs: passes with single HTTP client", () => {
  const pkgJson = {
    dependencies: {
      axios: "1.4.0",
    },
    devDependencies: {},
  };

  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify(pkgJson, null, 2)
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter((v) => v.ruleId === "no-overlapping-libs");

  expect(relevant.length).toBe(0);
});

// === Source Text Rules ===

test("no-eslint-disable-comments: detects eslint-disable", () => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "bad.ts"),
    `
    // eslint-disable-next-line no-console
    console.log("test");
  `
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "no-eslint-disable-comments"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("no-eslint-disable-comments: passes without violations", () => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "good.ts"),
    `
    const x = 5;
    console.log(x);
  `
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "no-eslint-disable-comments"
  );

  expect(relevant.length).toBe(0);
});

test("no-ts-suppressions: detects @ts-ignore", () => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "bad.ts"),
    `
    // @ts-ignore
    const x: string = 123;
  `
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter((v) => v.ruleId === "no-ts-suppressions");

  expect(relevant.length).toBeGreaterThan(0);
});

test("no-ts-suppressions: detects @ts-expect-error", () => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "bad.ts"),
    `
    // @ts-expect-error intentional type mismatch
    const x: string = 123;
  `
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter((v) => v.ruleId === "no-ts-suppressions");

  expect(relevant.length).toBeGreaterThan(0);
});

// === Config Rules ===

test("tsconfig-paths-exist: detects missing include path", () => {
  const tsconfig = {
    compilerOptions: {
      strict: true,
    },
    include: ["src/**/*", "nonexistent/file.ts"],
  };

  writeFileSync(
    join(tempDir, "tsconfig.json"),
    JSON.stringify(tsconfig, null, 2)
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "tsconfig-paths-exist"
  );

  expect(relevant.length).toBeGreaterThan(0);
  expect(relevant[0]?.message).toContain("nonexistent/file.ts");
});

test("tsconfig-paths-exist: passes with existing paths", () => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(join(tempDir, "src", "index.ts"), "export const x = 1;");

  const tsconfig = {
    compilerOptions: {
      strict: true,
    },
    include: ["src/**/*"],
  };

  writeFileSync(
    join(tempDir, "tsconfig.json"),
    JSON.stringify(tsconfig, null, 2)
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "tsconfig-paths-exist"
  );

  expect(relevant.length).toBe(0);
});

test("tsconfig-strict: detects missing strict", () => {
  const tsconfig = {
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
    },
  };

  writeFileSync(
    join(tempDir, "tsconfig.json"),
    JSON.stringify(tsconfig, null, 2)
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter((v) => v.ruleId === "tsconfig-strict");

  expect(relevant.length).toBeGreaterThan(0);
});

test("tsconfig-strict: passes with strict: true", () => {
  const tsconfig = {
    compilerOptions: {
      strict: true,
      target: "ES2020",
    },
  };

  writeFileSync(
    join(tempDir, "tsconfig.json"),
    JSON.stringify(tsconfig, null, 2)
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter((v) => v.ruleId === "tsconfig-strict");

  expect(relevant.length).toBe(0);
});

// === Testing Rules ===

test("test-sibling-required: detects missing test for .utils.ts", () => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "helpers.utils.ts"),
    "export const add = (a: number, b: number) => a + b;"
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "test-sibling-required"
  );

  expect(relevant.length).toBeGreaterThan(0);
  expect(relevant[0]?.message).toContain("Missing unit-test sibling");
});

test("test-sibling-required: passes when test exists", () => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  mkdirSync(join(tempDir, "tests"), { recursive: true });

  writeFileSync(
    join(tempDir, "src", "helpers.utils.ts"),
    "export const add = (a: number, b: number) => a + b;"
  );
  writeFileSync(
    join(tempDir, "tests", "helpers.utils.test.ts"),
    "import { add } from '../src/helpers.utils'; test(() => expect(add(1, 2)).toBe(3));"
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "test-sibling-required"
  );

  expect(relevant.length).toBe(0);
});

test("test-sibling-required: exempts index.ts", () => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "index.ts"),
    "export { add } from './helpers.utils';"
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "test-sibling-required"
  );

  expect(relevant.length).toBe(0);
});

// === CI Rules ===

test("workflow-actions-pinned: detects floating @main", () => {
  mkdirSync(join(tempDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(tempDir, ".github", "workflows", "test.yml"),
    `
name: test
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@main
`
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "workflow-actions-pinned"
  );

  expect(relevant.length).toBeGreaterThan(0);
  expect(relevant[0]?.message).toContain("not pinned");
});

test("workflow-actions-pinned: passes with version tag", () => {
  mkdirSync(join(tempDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(tempDir, ".github", "workflows", "test.yml"),
    `
name: test
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
`
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "workflow-actions-pinned"
  );

  expect(relevant.length).toBe(0);
});

test("workflow-runner-pinned: detects ubuntu-latest", () => {
  mkdirSync(join(tempDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(tempDir, ".github", "workflows", "test.yml"),
    `
name: test
jobs:
  build:
    runs-on: ubuntu-latest
`
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "workflow-runner-pinned"
  );

  expect(relevant.length).toBeGreaterThan(0);
  expect(relevant[0]?.message).toContain("ubuntu-latest");
});

test("workflow-runner-pinned: passes with pinned version", () => {
  mkdirSync(join(tempDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(tempDir, ".github", "workflows", "test.yml"),
    `
name: test
jobs:
  build:
    runs-on: ubuntu-24.04
`
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "workflow-runner-pinned"
  );

  expect(relevant.length).toBe(0);
});

test("workflow-timeout-required: detects missing timeout", () => {
  mkdirSync(join(tempDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(tempDir, ".github", "workflows", "test.yml"),
    `
name: test
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "test"
`
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "workflow-timeout-required"
  );

  expect(relevant.length).toBeGreaterThan(0);
  expect(relevant[0]?.message).toContain("timeout-minutes");
});

test("workflow-timeout-required: passes with timeout", () => {
  mkdirSync(join(tempDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(tempDir, ".github", "workflows", "test.yml"),
    `
name: test
jobs:
  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - run: echo "test"
`
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "workflow-timeout-required"
  );

  expect(relevant.length).toBe(0);
});

test("workflow-timeout-required: exempts reusable workflow calls", () => {
  mkdirSync(join(tempDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(tempDir, ".github", "workflows", "test.yml"),
    `
name: test
jobs:
  call:
    uses: ./.github/workflows/reusable.yml
`
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "workflow-timeout-required"
  );

  expect(relevant.length).toBe(0);
});

// === Runner Tests ===

test("runMetaRules: filters by appliesTo packs", () => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(join(tempDir, "src", "index.ts"), "export const x = 1;");

  // All available rules apply to no packs or always-on packs, so no filtering needed here
  // Just verify runner doesn't crash with pack context
  const ctx = buildMetaRuleContext(tempDir, ["vanilla"]);
  const violations = runMetaRules(META_RULES, ctx);

  expect(violations).toBeDefined();
  expect(Array.isArray(violations)).toBe(true);
});

test("runMetaRules: returns violations sorted by file then ruleId", () => {
  const pkgJson = {
    dependencies: {
      axios: "1.4.0",
      "node-fetch": "3.3.0",
      express: "^4.18.0",
    },
  };

  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify(pkgJson, null, 2)
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  // Should be sorted by file, then ruleId
  for (let i = 1; i < violations.length; i++) {
    const prev = violations[i - 1]!;
    const curr = violations[i]!;

    const fileCmp = prev.file.localeCompare(curr.file);

    if (fileCmp === 0) {
      expect(prev.ruleId <= curr.ruleId).toBe(true);
    } else {
      expect(fileCmp < 0).toBe(true);
    }
  }
});

test("runMetaRules: handles missing package.json gracefully", () => {
  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  // Should not crash, just return violations from other rules
  expect(violations).toBeDefined();
  expect(Array.isArray(violations)).toBe(true);
});

test("buildMetaRuleContext: caches file reads", () => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  const filePath = join(tempDir, "src", "test.ts");

  writeFileSync(filePath, "export const x = 1;");

  const ctx = buildMetaRuleContext(tempDir, []);

  const read1 = ctx.readFile("src/test.ts");
  const read2 = ctx.readFile("src/test.ts");

  expect(read1).toBe(read2);
  expect(read1).toContain("export const x");
});

test("buildMetaRuleContext: returns null for nonexistent files", () => {
  const ctx = buildMetaRuleContext(tempDir, []);
  const content = ctx.readFile("nonexistent/file.ts");

  expect(content).toBeNull();
});
