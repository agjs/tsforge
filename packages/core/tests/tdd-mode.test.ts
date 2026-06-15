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

test("buildSystemPrompt appends TEST-FIRST guidance only when TDD mode is on", () => {
  delete process.env.TSFORGE_TDD;
  expect(buildSystemPrompt(false, undefined)).not.toContain("TEST-FIRST");

  process.env.TSFORGE_TDD = "1";
  const tdd = buildSystemPrompt(false, undefined);

  expect(tdd).toContain("TEST-FIRST");
  expect(tdd).toContain("SEE IT FAIL");
});

function logicProjectWithoutTest(): string {
  const dir = mkdtempSync(join(tmpdir(), "tsforge-tdd-"));

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "account.service.ts"),
    "export const balance = (n: number): number => n;\n"
  );

  return dir;
}

test("test-sibling-required is a WARN by default", () => {
  delete process.env.TSFORGE_TDD;
  const dir = logicProjectWithoutTest();

  try {
    const v = runMetaRules(META_RULES, buildMetaRuleContext(dir, [])).filter(
      (x) => x.ruleId === "test-sibling-required"
    );

    expect(v.length).toBeGreaterThan(0);
    expect(v[0]?.severity).toBe("warn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test-sibling-required is an ERROR in TDD mode (missing test fails the gate)", () => {
  process.env.TSFORGE_TDD = "1";
  const dir = logicProjectWithoutTest();

  try {
    const v = runMetaRules(META_RULES, buildMetaRuleContext(dir, [])).filter(
      (x) => x.ruleId === "test-sibling-required"
    );

    expect(v.length).toBeGreaterThan(0);
    expect(v[0]?.severity).toBe("error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
