import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { runReviewCommand } from "../src/cli/repl-commands";
import { stripSgr } from "../src/render";

/** Same two-pass stub as review-change.test.ts: find vs verify keyed on prompt. */
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
  repo = mkdtempSync(join(tmpdir(), "tsforge-revcmd-"));
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(
    join(repo, "discount.ts"),
    "export const a = 1;\nexport const b = 2;\n"
  );
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  writeFileSync(
    join(repo, "discount.ts"),
    "export const a = 1;\nexport const b = 99;\n"
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// The /review → /reviewfix contract: the command must RETURN the plain findings so
// the REPL can store them for /reviewfix (the bug was it returned nothing, so
// /reviewfix always said "no findings" after a manual /review).
test("returns the plain findings text when there are findings (feeds /reviewfix)", async () => {
  const out: string[] = [];
  const findings = await runReviewCommand(
    stub(FINDINGS, true),
    repo,
    "",
    (s) => out.push(s),
    80
  );

  expect(findings).toContain("subtraction is reversed");
  expect(findings).toContain("discount.ts:2");
  // Plain text (no ANSI) — /reviewfix hands it to the agent verbatim.
  expect(stripSgr(findings)).toBe(findings);
});

test("returns an empty string when the review is clean (so /reviewfix says nothing to fix)", async () => {
  // Verify rejects the finding ⇒ zero verified findings ⇒ empty return.
  const findings = await runReviewCommand(
    stub(FINDINGS, false),
    repo,
    "",
    () => {},
    80
  );

  expect(findings).toBe("");
});

test("still renders to the sink (the display path is unaffected)", async () => {
  let printed = "";

  await runReviewCommand(
    stub(FINDINGS, true),
    repo,
    "",
    (s) => {
      printed += s;
    },
    80
  );

  expect(printed).toContain("subtraction is reversed");
});
