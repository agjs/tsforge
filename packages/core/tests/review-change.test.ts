import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { reviewChange, formatReport, LENSES } from "../src/loop/review";

/** A provider that answers the find pass and the verify pass differently,
 *  keyed on the system prompt (so call order doesn't matter). */
function stub(findings: string, verifyReal: boolean): IProvider {
  return {
    async complete(messages) {
      const sys = messages.find((m) => m.role === "system")?.content ?? "";
      const body = sys.includes("verifying a code-review finding")
        ? JSON.stringify({ real: verifyReal, verdict: "judged" })
        : findings;

      return { content: body, toolCalls: [] };
    },
  };
}

const FINDINGS = JSON.stringify({
  findings: [
    {
      line: 2,
      severity: "error",
      lens: "correctness",
      claim: "subtraction is reversed",
      reason: "returns a negative discount",
    },
  ],
});

let repo: string;
const git = (...a: string[]): void =>
  void execFileSync("git", a, { cwd: repo, stdio: "ignore" });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "tsforge-review-"));
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(
    join(repo, "discount.ts"),
    "export function discount(price: number, off: number): number {\n  return price - off;\n}\n"
  );
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  // a working-tree change (uncommitted) — the thing under review
  writeFileSync(
    join(repo, "discount.ts"),
    "export function discount(price: number, off: number): number {\n  return off - price;\n}\n"
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("reviews the uncommitted change and keeps a verified finding", async () => {
  const report = await reviewChange(stub(FINDINGS, true), repo);

  expect(report.changedFiles).toContain("discount.ts");
  expect(report.findings).toHaveLength(1);
  expect(report.findings[0]?.lens).toBe("correctness");
  expect(report.rejected).toBe(0);
});

test("adversarial verify drops a finding the code doesn't confirm", async () => {
  const report = await reviewChange(stub(FINDINGS, false), repo);

  expect(report.findings).toHaveLength(0);
  expect(report.rejected).toBe(1);
});

test("no changed source files → nothing to review", async () => {
  git("add", "-A");
  git("commit", "-q", "-m", "commit the change");
  const report = await reviewChange(stub(FINDINGS, true), repo);

  expect(report.changedFiles).toHaveLength(0);
  expect(formatReport(report)).toContain("No changed source files");
});

test("malformed model output yields no findings (no throw)", async () => {
  const report = await reviewChange(stub("not json", true), repo);

  expect(report.findings).toHaveLength(0);
});

test("formatReport surfaces a verified finding with file:line and lens", async () => {
  const report = await reviewChange(stub(FINDINGS, true), repo);
  const text = formatReport(report);

  expect(text).toContain("discount.ts:2");
  expect(text).toContain("[correctness]");
  expect(text).toContain("subtraction is reversed");
});

test("a string line number from the model is parsed, not defaulted to 1", async () => {
  const stringLine = JSON.stringify({
    findings: [
      {
        line: "2",
        severity: "error",
        lens: "correctness",
        claim: "subtraction is reversed",
        reason: "x",
      },
    ],
  });
  const report = await reviewChange(stub(stringLine, true), repo);

  expect(report.findings[0]?.line).toBe(2);
});

test("the senior-review rubric ships with the expected lenses", () => {
  const ids = LENSES.map((l) => l.id);

  expect(ids).toContain("correctness");
  expect(ids).toContain("regressions");
  expect(ids).toContain("business-logic");
  expect(
    LENSES.every((l) => l.questions.length > 0 && l.example.length > 0)
  ).toBe(true);
});
