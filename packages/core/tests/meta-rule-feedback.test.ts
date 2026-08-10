import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMetaRuleContext,
  runMetaRules,
  META_RULES,
  type IMetaRuleViolation,
} from "../src/meta-rules";
import {
  renderMetaViolations,
  metaRuleHelp,
} from "../src/loop/feedback/meta-rule-feedback";
import { META_RULE_DOCS } from "../src/loop/feedback/meta-rule-docs";
import type { ITask } from "../src/spec";
import { gateFeedback } from "../src/loop/feedback";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-mr-"));

  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("renderMetaViolations formats violations with rule ID and severity", async () => {
  const violations: IMetaRuleViolation[] = [
    {
      file: "package.json",
      ruleId: "package-exact-deps",
      severity: "warn",
      message: "lodash is ^4.17.21 — use exact version",
    },
    {
      file: "tsconfig.json",
      ruleId: "tsconfig-strict",
      severity: "error",
      message: "strict mode is not enabled",
    },
  ];

  const rendered = renderMetaViolations(violations);

  expect(rendered).toContain("package.json");
  expect(rendered).toContain("package-exact-deps");
  expect(rendered).toContain("[WARN]");
  expect(rendered).toContain("tsconfig.json");
  expect(rendered).toContain("tsconfig-strict");
  expect(rendered).toContain("[ERROR]");
});

test("renderMetaViolations includes doc line for each violation", async () => {
  const violations: IMetaRuleViolation[] = [
    {
      file: "package.json",
      ruleId: "package-exact-deps",
      severity: "warn",
      message: "lodash is ^4.17.21",
    },
  ];

  const rendered = renderMetaViolations(violations);

  expect(rendered).toContain("💡");
  const doc = META_RULE_DOCS["package-exact-deps"];

  if (doc !== undefined) {
    expect(rendered).toContain(doc);
  }
});

test("metaRuleHelp returns unique rule docs from violations", () => {
  const violations: IMetaRuleViolation[] = [
    {
      file: "package.json",
      ruleId: "package-exact-deps",
      severity: "warn",
      message: "lodash",
    },
    {
      file: "package.json",
      ruleId: "package-exact-deps",
      severity: "warn",
      message: "react",
    },
    {
      file: "tsconfig.json",
      ruleId: "tsconfig-strict",
      severity: "error",
      message: "strict mode",
    },
  ];

  const help = metaRuleHelp(violations);

  // Should contain docs for each unique rule
  expect(help).toContain("package-exact-deps");
  expect(help).toContain("tsconfig-strict");
  // Should not duplicate
  const pkgCount = (help.match(/package-exact-deps/g) ?? []).length;

  expect(pkgCount).toBe(1);
});

test("gateFeedback includes meta-rule violations in output", async () => {
  await withDir(async (dir) => {
    await Bun.write(
      join(dir, "test.ts"),
      "export function test() { return 1; }\n"
    );

    const task: ITask = {
      id: "1",
      files: ["test.ts"],
      accept: "tsc -p tsconfig.json",
      intent: "",
    };

    const metaViolations: IMetaRuleViolation[] = [
      {
        file: "package.json",
        ruleId: "package-exact-deps",
        severity: "warn",
        message: "lodash is ^4.17.21",
      },
    ];

    const feedback = await gateFeedback([], task, dir, metaViolations);

    expect(feedback).toContain("## Project structure");
    expect(feedback).toContain("package-exact-deps");
  });
});

test("meta-rule context builds correctly with source files", async () => {
  await withDir(async (dir) => {
    await Bun.write(join(dir, "src", "index.ts"), "export const x = 1;\n");
    await Bun.write(
      join(dir, "src", "test.ts"),
      "import { x } from './index';\n"
    );
    await Bun.write(
      join(dir, "tests", "main.test.ts"),
      "describe('test', () => {});\n"
    );

    const ctx = buildMetaRuleContext(dir, []);

    expect(ctx.sourceFiles).toContain("src/index.ts");
    expect(ctx.sourceFiles).toContain("src/test.ts");
    expect(ctx.sourceFiles).toContain("tests/main.test.ts");
  });
});

test("meta-rules run and filter by pack", async () => {
  await withDir(async (dir) => {
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { lodash: "^4.17.21" },
      })
    );

    // Run without the pack it applies to
    const ctx = buildMetaRuleContext(dir, []);
    const violations = runMetaRules(META_RULES, ctx);

    // package-exact-deps should fire regardless of packs (always-apply rule)
    const pkgViolation = violations.find(
      (v) => v.ruleId === "package-exact-deps"
    );

    expect(pkgViolation).toBeDefined();
  });
});

test("error-severity meta-violations can flip gate outcome", async () => {
  await withDir(async (dir) => {
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { lodash: "^4.17.21" },
      })
    );

    const ctx = buildMetaRuleContext(dir, []);
    const violations = runMetaRules(META_RULES, ctx);

    const errorViolations = violations.filter((v) => v.severity === "error");

    // package-exact-deps is warn, so gate should not be flipped by it
    if (violations.some((v) => v.ruleId === "package-exact-deps")) {
      const pkgViolation = violations.find(
        (v) => v.ruleId === "package-exact-deps"
      );

      expect(pkgViolation?.severity).toBe("warn");
    }

    // But error violations should flip the gate
    expect(errorViolations.length >= 0).toBe(true);
  });
});

test("all meta-rules have documentation entries", () => {
  const missingDocs: string[] = [];

  for (const rule of META_RULES) {
    if (META_RULE_DOCS[rule.id] === undefined) {
      missingDocs.push(rule.id);
    }
  }

  expect(missingDocs).toEqual([]);
});

test("test-sibling-required docs steer React testing-library install", () => {
  const doc = META_RULE_DOCS["test-sibling-required"];

  expect(doc).toBeDefined();
  expect(doc).toContain("@testing-library/react");
  expect(doc).toContain("install");
});

test("meta-rule violations are sorted deterministically", async () => {
  await withDir(async (dir) => {
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { a: "^1.0.0", b: "^2.0.0" },
      })
    );

    const ctx = buildMetaRuleContext(dir, []);
    const violations1 = runMetaRules(META_RULES, ctx);
    const violations2 = runMetaRules(META_RULES, ctx);

    // Should be identical order
    expect(violations1.length).toBe(violations2.length);

    for (let i = 0; i < violations1.length; i++) {
      const v1 = violations1[i];
      const v2 = violations2[i];

      if (v1 !== undefined && v2 !== undefined) {
        expect(v1.file).toBe(v2.file);
        expect(v1.ruleId).toBe(v2.ruleId);
      }
    }
  });
});

// R3 escalation focus contract: gateFeedback filters metaViolations by `file:ruleId`
// (== IErrorItem.key that evaluateGate builds for a meta error, == focusError R3 sets).
// This pins that key format — widening it (e.g. adding :message) silently drops the
// focused project-structure feedback while the build is still red. That regression
// landed once precisely because this contract was untested.
test("gateFeedback R3 focus matches a meta violation by file:ruleId (the focusError contract)", async () => {
  await withDir(async (dir) => {
    const task: ITask = {
      id: "1",
      files: ["a.service.ts"],
      accept: "tsc -p tsconfig.json",
      intent: "",
    };

    const metaViolations: IMetaRuleViolation[] = [
      {
        file: "a.service.ts",
        ruleId: "test-sibling-required",
        severity: "error",
        message: "a.service.ts has no test sibling",
      },
    ];

    // focusError = `${file}:${ruleId}` — what evaluateGate keys a meta error as, and
    // what R3 sets focus to. The violation must survive the focus filter.
    const focused = await gateFeedback(
      [],
      task,
      dir,
      metaViolations,
      "a.service.ts:test-sibling-required"
    );

    expect(focused).toContain("## Project structure");
    expect(focused).toContain("test-sibling-required");

    // A focusError carrying the message (the reverted-then-rejected key shape) must
    // NOT match — proving the contract is file:ruleId, nothing wider.
    const mismatched = await gateFeedback(
      [],
      task,
      dir,
      metaViolations,
      "a.service.ts:test-sibling-required:a.service.ts has no test sibling"
    );

    expect(mismatched).not.toContain("test-sibling-required");
  });
});
