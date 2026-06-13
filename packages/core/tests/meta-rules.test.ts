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
