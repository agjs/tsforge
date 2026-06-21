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
import type {
  IMetaRule,
  IMetaRuleContext,
  IMetaRuleViolation,
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

  const ctx = buildMetaRuleContext(tempDir, [], ["src/bad.ts"]);
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

  const ctx = buildMetaRuleContext(tempDir, [], ["src/good.ts"]);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "no-eslint-disable-comments"
  );

  expect(relevant.length).toBe(0);
});

test("source-text rules: skip *.gen.ts (codegen ships eslint-disable + @ts-nocheck)", () => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "routeTree.gen.ts"),
    `/* eslint-disable */
    // @ts-nocheck
    export const routeTree = {};
  `
  );

  // The .gen.ts is in the change set, so the skip must come from the rule's own
  // path self-check (isScannableSource), not from an upstream file-walk filter.
  const ctx = buildMetaRuleContext(tempDir, [], ["src/routeTree.gen.ts"]);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) =>
      v.ruleId === "no-eslint-disable-comments" ||
      v.ruleId === "no-ts-suppressions"
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

  const ctx = buildMetaRuleContext(tempDir, [], ["src/bad.ts"]);
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

  const ctx = buildMetaRuleContext(tempDir, [], ["src/bad.ts"]);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter((v) => v.ruleId === "no-ts-suppressions");

  expect(relevant.length).toBeGreaterThan(0);
});

test("source-text rules are change-scoped: ignore pre-existing untouched files", () => {
  // A brownfield repo with a legacy file that already has an eslint-disable plus
  // a TS suppression comment. The agent touched NOTHING (changedFiles=[]), so the
  // gate must not flag the legacy file — otherwise it can never go green on a repo
  // it didn't author. Regression for the full-tree-scan change-scoping break.
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "legacy.ts"),
    `/* eslint-disable no-console */
    // @ts-ignore
    export const legacy = 1;
  `
  );

  const ctx = buildMetaRuleContext(tempDir, [], []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) =>
      v.ruleId === "no-eslint-disable-comments" ||
      v.ruleId === "no-ts-suppressions"
  );

  expect(relevant).toEqual([]);
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

test("tsconfig-recommended-flags: detects missing flags", () => {
  const tsconfig = {
    compilerOptions: {
      strict: true,
    },
  };

  writeFileSync(
    join(tempDir, "tsconfig.json"),
    JSON.stringify(tsconfig, null, 2)
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "tsconfig-recommended-flags"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("fastify-security-plugins: warns when plugins missing", () => {
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify(
      {
        dependencies: { fastify: "5.0.0" },
      },
      null,
      2
    )
  );

  const ctx = buildMetaRuleContext(tempDir, ["fastify"]);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "fastify-security-plugins"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("fastify-security-plugins: skipped without fastify pack context", () => {
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify(
      {
        dependencies: { fastify: "5.0.0" },
      },
      null,
      2
    )
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "fastify-security-plugins"
  );

  expect(relevant.length).toBe(0);
});

test("next-proxy-over-middleware: warns when middleware exists without proxy", () => {
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "16.0.0" } }, null, 2)
  );
  writeFileSync(
    join(tempDir, "middleware.ts"),
    "export function middleware() {}"
  );

  const ctx = buildMetaRuleContext(tempDir, ["nextjs"]);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "next-proxy-over-middleware"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("next-instrumentation-present: warns when app router lacks instrumentation.ts", () => {
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "16.0.0" } }, null, 2)
  );
  mkdirSync(join(tempDir, "src", "app"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "app", "page.tsx"),
    "export default function Page() { return null; }"
  );

  const ctx = buildMetaRuleContext(tempDir, ["nextjs"]);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "next-instrumentation-present"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("next-image-remote-patterns-no-wildcards: reports wildcard hostname", () => {
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "16.0.0" } }, null, 2)
  );
  writeFileSync(
    join(tempDir, "next.config.ts"),
    `export default { images: { remotePatterns: [{ protocol: "https", hostname: "**" }] } };`
  );

  const ctx = buildMetaRuleContext(tempDir, ["nextjs"]);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "next-image-remote-patterns-no-wildcards"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("next-image-remote-patterns-no-wildcards: passes with explicit hostname", () => {
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "16.0.0" } }, null, 2)
  );
  writeFileSync(
    join(tempDir, "next.config.ts"),
    `export default { images: { remotePatterns: [{ protocol: "https", hostname: "cdn.example.com" }] } };`
  );

  const ctx = buildMetaRuleContext(tempDir, ["nextjs"]);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "next-image-remote-patterns-no-wildcards"
  );

  expect(relevant.length).toBe(0);
});

// === Testing Rules ===

test("test-sibling-required: detects missing test for .utils.ts", () => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "helpers.utils.ts"),
    "export const add = (a: number, b: number) => a + b;"
  );

  // Scoped to changed files: the agent touched helpers.utils.ts.
  const ctx = buildMetaRuleContext(tempDir, [], ["src/helpers.utils.ts"]);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "test-sibling-required"
  );

  expect(relevant.length).toBeGreaterThan(0);
  expect(relevant[0]?.message).toContain("Missing test");
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

  // Mirrored tests/ file satisfies it even though the file is in the changed set.
  const ctx = buildMetaRuleContext(tempDir, [], ["src/helpers.utils.ts"]);
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

  const ctx = buildMetaRuleContext(tempDir, [], ["src/index.ts"]);
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

test("workflow-permissions-explicit: detects missing permissions", () => {
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
    (v) => v.ruleId === "workflow-permissions-explicit"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("workflow-permissions-explicit: passes with workflow permissions", () => {
  mkdirSync(join(tempDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(tempDir, ".github", "workflows", "test.yml"),
    `
name: test
permissions:
  contents: read
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
    (v) => v.ruleId === "workflow-permissions-explicit"
  );

  expect(relevant.length).toBe(0);
});

test("workflow-permissions-least-privilege: warns on workflow contents write", () => {
  mkdirSync(join(tempDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(tempDir, ".github", "workflows", "test.yml"),
    `
name: test
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-24.04
`
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "workflow-permissions-least-privilege"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("no-pull-request-target-untrusted-checkout: detects unsafe checkout", () => {
  mkdirSync(join(tempDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(tempDir, ".github", "workflows", "test.yml"),
    `
name: test
on:
  pull_request_target:
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
`
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "no-pull-request-target-untrusted-checkout"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("no-github-context-in-shell: detects github.event in run", () => {
  mkdirSync(join(tempDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(tempDir, ".github", "workflows", "test.yml"),
    `
name: test
jobs:
  build:
    steps:
      - run: echo "\${{ github.event.issue.title }}"
`
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "no-github-context-in-shell"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("lockfile-required: detects missing lockfile", () => {
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify({ packageManager: "bun@1.3.14" }, null, 2)
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter((v) => v.ruleId === "lockfile-required");

  expect(relevant.length).toBeGreaterThan(0);
});

test("single-package-manager: detects mixed lockfiles", () => {
  writeFileSync(join(tempDir, "package-lock.json"), "{}");
  writeFileSync(join(tempDir, "yarn.lock"), "# yarn");

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "single-package-manager"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("package-manager-field-required: detects missing field", () => {
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify({ name: "demo" }, null, 2)
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "package-manager-field-required"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("no-git-or-tarball-dependencies: detects git dependency", () => {
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify(
      {
        dependencies: {
          demo: "git+https://github.com/example/demo.git",
        },
      },
      null,
      2
    )
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "no-git-or-tarball-dependencies"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("dependency-overrides-require-comment: detects uncommented overrides", () => {
  writeFileSync(
    join(tempDir, "package.json"),
    `{
  "name": "demo",
  "overrides": {
    "lodash": "4.17.21"
  }
}`
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "dependency-overrides-require-comment"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("production-must-not-use-drizzle-push: detects push script", () => {
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify(
      {
        scripts: {
          "db:push": "drizzle-kit push",
        },
      },
      null,
      2
    )
  );

  const ctx = buildMetaRuleContext(tempDir, ["drizzle"]);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "production-must-not-use-drizzle-push"
  );

  expect(relevant.length).toBeGreaterThan(0);
});

test("migrations-must-be-checked-in: detects missing migration dir", () => {
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { "drizzle-orm": "0.36.0" } }, null, 2)
  );

  const ctx = buildMetaRuleContext(tempDir, ["drizzle"]);
  const violations = runMetaRules(META_RULES, ctx);

  const relevant = violations.filter(
    (v) => v.ruleId === "migrations-must-be-checked-in"
  );

  expect(relevant.length).toBeGreaterThan(0);
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

// === Dockerfile (container) Rules ===

test("dockerfile-base-image-pinned: flags :latest and untagged FROM", () => {
  writeFileSync(join(tempDir, "Dockerfile"), "FROM node:latest\nRUN echo hi\n");

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx).filter(
    (v) => v.ruleId === "dockerfile-base-image-pinned"
  );

  expect(violations.length).toBeGreaterThan(0);
  expect(violations[0]?.severity).toBe("error");
});

test("dockerfile-base-image-pinned: passes a pinned tag and skips build stages", () => {
  writeFileSync(
    join(tempDir, "Dockerfile"),
    "FROM node:24.3.0-bookworm AS build\nFROM build\nUSER node\n"
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx).filter(
    (v) => v.ruleId === "dockerfile-base-image-pinned"
  );

  expect(violations).toHaveLength(0);
});

test("dockerfile-non-root-user: flags a Dockerfile with no USER", () => {
  writeFileSync(
    join(tempDir, "Dockerfile"),
    'FROM node:24.3.0-bookworm\nRUN echo hi\nCMD ["node", "x.js"]\n'
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx).filter(
    (v) => v.ruleId === "dockerfile-non-root-user"
  );

  expect(violations.length).toBeGreaterThan(0);
});

test("dockerfile-non-root-user: passes when a non-root USER is set", () => {
  writeFileSync(
    join(tempDir, "Dockerfile"),
    'FROM node:24.3.0-bookworm\nUSER node\nCMD ["node", "x.js"]\n'
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx).filter(
    (v) => v.ruleId === "dockerfile-non-root-user"
  );

  expect(violations).toHaveLength(0);
});

test("dockerfile-no-secrets-in-env-arg: flags a secret literal in ENV", () => {
  writeFileSync(
    join(tempDir, "Dockerfile"),
    "FROM node:24.3.0-bookworm\nENV OPENAI_API_KEY=sk-secret\nUSER node\n"
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx).filter(
    (v) => v.ruleId === "dockerfile-no-secrets-in-env-arg"
  );

  expect(violations.length).toBeGreaterThan(0);
});

test("dockerfile-no-secrets-in-env-arg: allows a non-secret ENV and a bare ARG", () => {
  writeFileSync(
    join(tempDir, "Dockerfile"),
    "FROM node:24.3.0-bookworm\nENV NODE_ENV=production\nARG API_KEY\nUSER node\n"
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx).filter(
    (v) => v.ruleId === "dockerfile-no-secrets-in-env-arg"
  );

  expect(violations).toHaveLength(0);
});

test("dockerfiles: context collects root Dockerfile and one level down", () => {
  mkdirSync(join(tempDir, "docker"), { recursive: true });
  writeFileSync(join(tempDir, "Dockerfile"), "FROM node:24.3.0\nUSER node\n");
  writeFileSync(
    join(tempDir, "docker", "api.Dockerfile"),
    "FROM node:24.3.0\nUSER node\n"
  );

  const ctx = buildMetaRuleContext(tempDir, []);

  expect(ctx.dockerfiles).toContain("Dockerfile");
  expect(ctx.dockerfiles).toContain(join("docker", "api.Dockerfile"));
});

// === Supply-chain: no-undeclared-dependencies ===

test("no-undeclared-dependencies: flags an import with no matching dep", () => {
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify({ name: "x", dependencies: { zod: "3.0.0" } })
  );
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "a.ts"),
    `import _ from "lodash";\nexport const x = _;\n`
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx).filter(
    (v) => v.ruleId === "no-undeclared-dependencies"
  );

  expect(violations.length).toBeGreaterThan(0);
  expect(violations[0]?.message).toContain("lodash");
});

test("no-undeclared-dependencies: allows declared deps, builtins, subpaths, and @types", () => {
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify({
      name: "x",
      dependencies: { "react-dom": "19.0.0" },
      devDependencies: { "@types/node": "24.0.0" },
    })
  );
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "a.ts"),
    `import { createRoot } from "react-dom/client";\nimport { join } from "node:path";\nimport process from "node:process";\nexport const x = [createRoot, join, process];\n`
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx).filter(
    (v) => v.ruleId === "no-undeclared-dependencies"
  );

  expect(violations).toHaveLength(0);
});

// === Structure: no-circular-imports ===

test("no-circular-imports: flags a two-module cycle", () => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "a.ts"),
    `import { b } from "./b";\nexport const a = b;\n`
  );
  writeFileSync(
    join(tempDir, "src", "b.ts"),
    `import { a } from "./a";\nexport const b = a;\n`
  );

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx).filter(
    (v) => v.ruleId === "no-circular-imports"
  );

  expect(violations.length).toBeGreaterThan(0);
  expect(violations[0]?.message).toContain("src/a.ts");
  expect(violations[0]?.message).toContain("src/b.ts");
});

test("no-circular-imports: passes an acyclic graph", () => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "a.ts"),
    `import { b } from "./b";\nexport const a = b;\n`
  );
  writeFileSync(
    join(tempDir, "src", "b.ts"),
    `import { c } from "./c";\nexport const b = c;\n`
  );
  writeFileSync(join(tempDir, "src", "c.ts"), `export const c = 1;\n`);

  const ctx = buildMetaRuleContext(tempDir, []);
  const violations = runMetaRules(META_RULES, ctx).filter(
    (v) => v.ruleId === "no-circular-imports"
  );

  expect(violations).toHaveLength(0);
});

// === Per-rule isolation (a throwing rule must not disable the others) ===

function emptyMetaContext(): IMetaRuleContext {
  return {
    root: "/ws",
    packageJson: null,
    sourceFiles: [],
    changedFiles: [],
    configFiles: [],
    workflowFiles: [],
    dockerfiles: [],
    activePacks: [],
    readFile: () => null,
  };
}

test("runMetaRules isolates a throwing rule — others still enforce, no silent disable", () => {
  const boom: IMetaRule = {
    id: "boom-rule",
    category: "config",
    description: "throws on purpose",
    severity: "error",
    run: () => {
      throw new Error("kaboom");
    },
  };

  const good: IMetaRule = {
    id: "good-rule",
    category: "config",
    description: "reports a real violation",
    severity: "error",
    run: (): IMetaRuleViolation[] => [
      {
        file: "src/a.ts",
        ruleId: "good-rule",
        severity: "error",
        message: "real violation",
      },
    ],
  };

  // boom runs FIRST: before the fix it threw out of runMetaRules and the good
  // rule never ran (its real error went unreported — a false green).
  const violations = runMetaRules([boom, good], emptyMetaContext());

  // The good rule's real error still surfaces (enforcement preserved)...
  const goodHit = violations.find((v) => v.ruleId === "good-rule");

  expect(goodHit).toBeDefined();
  expect(goodHit?.severity).toBe("error");

  // ...and the throwing rule is surfaced as a NON-blocking warning, not a crash.
  const boomHit = violations.find((v) => v.ruleId === "boom-rule");

  expect(boomHit).toBeDefined();
  expect(boomHit?.severity).toBe("warn");
  expect(boomHit?.message).toContain("failed to run");
  expect(boomHit?.message).toContain("kaboom");
});

test("runMetaRules: a throwing rule silenced via override does not run or report", () => {
  const boom: IMetaRule = {
    id: "boom-rule",
    category: "config",
    description: "throws on purpose",
    severity: "error",
    run: () => {
      throw new Error("kaboom");
    },
  };

  const violations = runMetaRules([boom], emptyMetaContext(), {
    "boom-rule": "off",
  });

  expect(violations).toHaveLength(0);
});
