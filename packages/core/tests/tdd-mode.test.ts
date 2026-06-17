import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/loop/prompt";
import {
  buildMetaRuleContext,
  runMetaRules,
  META_RULES,
} from "../src/meta-rules";

afterEach(() => {
  delete process.env.TSFORGE_TDD;
});

const SERVICE = "src/account.service.ts";

test("TEST-FIRST guidance is on by default, off only when TSFORGE_TDD=0", () => {
  delete process.env.TSFORGE_TDD;
  expect(buildSystemPrompt(false, undefined)).toContain("TEST-FIRST");

  process.env.TSFORGE_TDD = "0";
  expect(buildSystemPrompt(false, undefined)).not.toContain("TEST-FIRST");
});

function logicProjectWithoutTest(): string {
  const dir = mkdtempSync(join(tmpdir(), "tsforge-tdd-"));

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, SERVICE),
    "export const balance = (n: number): number => n;\n"
  );

  return dir;
}

function siblingViolations(dir: string, changed: string[]) {
  return runMetaRules(
    META_RULES,
    buildMetaRuleContext(dir, [], changed)
  ).filter((x) => x.ruleId === "test-sibling-required");
}

test("errors by default on a CHANGED logic file with no test", () => {
  delete process.env.TSFORGE_TDD;
  const dir = logicProjectWithoutTest();

  try {
    const v = siblingViolations(dir, [SERVICE]);

    expect(v.length).toBeGreaterThan(0);
    expect(v[0]?.severity).toBe("error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downgrades to a warn when TSFORGE_TDD=0", () => {
  process.env.TSFORGE_TDD = "0";
  const dir = logicProjectWithoutTest();

  try {
    const v = siblingViolations(dir, [SERVICE]);

    expect(v[0]?.severity).toBe("warn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignores logic files the agent did NOT change (scoped to the diff)", () => {
  delete process.env.TSFORGE_TDD;
  const dir = logicProjectWithoutTest();

  try {
    // empty changed set → nothing is enforced (e.g. non-git, or untouched)
    expect(siblingViolations(dir, [])).toHaveLength(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a co-located *.test.ts satisfies the requirement", () => {
  delete process.env.TSFORGE_TDD;
  const dir = logicProjectWithoutTest();

  writeFileSync(
    join(dir, "src", "account.service.test.ts"),
    'import { test } from "bun:test";\ntest("x", () => {});\n'
  );

  try {
    expect(siblingViolations(dir, [SERVICE])).toHaveLength(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
