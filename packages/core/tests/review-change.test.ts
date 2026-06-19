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
  // Don't inherit a global commit.gpgsign=true — signing via an unavailable agent
  // would make these temp-repo commits fail spuriously.
  git("config", "commit.gpgsign", "false");
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

test("injects the caller blast-radius signal into the find prompt", async () => {
  // A two-file TS project (with tsconfig so the LanguageService loads): caller.ts
  // calls util.ts's export. Reviewing a change to util.ts should surface caller.ts
  // as a regression site in the find prompt.
  const proj = mkdtempSync(join(tmpdir(), "tsforge-signal-"));
  const pgit = (...a: string[]): void =>
    void execFileSync("git", a, { cwd: proj, stdio: "ignore" });

  writeFileSync(
    join(proj, "tsconfig.json"),
    '{"compilerOptions":{"strict":true,"skipLibCheck":true},"include":["*.ts"]}'
  );
  writeFileSync(
    join(proj, "util.ts"),
    "export function area(w: number, h: number): number {\n  return w * h;\n}\n"
  );
  writeFileSync(
    join(proj, "caller.ts"),
    'import { area } from "./util";\nexport const room = area(3, 4);\n'
  );
  pgit("init", "-q");
  pgit("config", "user.email", "t@t.t");
  pgit("config", "user.name", "t");
  pgit("config", "commit.gpgsign", "false");
  pgit("add", "-A");
  pgit("commit", "-q", "-m", "init");
  writeFileSync(
    join(proj, "util.ts"),
    "export function area(w: number, h: number): number {\n  return w + h;\n}\n"
  );

  let findPrompt = "";
  const capturing: IProvider = {
    async complete(messages) {
      const sys = messages.find((m) => m.role === "system")?.content ?? "";

      if (!sys.includes("verifying a code-review finding")) {
        findPrompt = messages.find((m) => m.role === "user")?.content ?? "";
      }

      return { content: JSON.stringify({ findings: [] }), toolCalls: [] };
    },
  };

  try {
    await reviewChange(capturing, proj);
    expect(findPrompt).toContain("Callers of this file's exports");
    expect(findPrompt).toContain("area");
    expect(findPrompt).toContain("caller.ts");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

/** Capture the find-pass SYSTEM prompt (the one that is NOT the verify prompt). */
function captureFindSystem(sink: { value: string }): IProvider {
  return {
    async complete(messages) {
      const sys = messages.find((m) => m.role === "system")?.content ?? "";

      if (!sys.includes("verifying a code-review finding")) {
        sink.value = sys;
      }

      return { content: JSON.stringify({ findings: [] }), toolCalls: [] };
    },
  };
}

test("gate-aware review tells the find pass not to duplicate failing gate rules", async () => {
  const sink = { value: "" };

  await reviewChange(captureFindSystem(sink), repo, {
    gateFailingRules: ["no-as-cast", "TS2322"],
  });

  expect(sink.value).toContain("no-as-cast");
  expect(sink.value).toContain("TS2322");
  expect(sink.value.toLowerCase()).toContain("already failing");
});

test("without a gate signal the find prompt has no gate clause (back-compat)", async () => {
  const sink = { value: "" };

  await reviewChange(captureFindSystem(sink), repo);

  expect(sink.value.toLowerCase()).not.toContain("already failing");
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
