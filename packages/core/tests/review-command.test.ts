import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { runReviewCommand } from "../src/cli/repl-commands";
import { stripSgr } from "../src/render";

/** A provider that drives one review AGENT: first call → investigate (git_context
 *  diff, the read-only step the runner requires before a result), then →
 *  agent_result. `finding` null ⇒ a clean review (no findings). */
function reviewerStub(
  finding: { source: string; detail: string } | null
): IProvider {
  let calls = 0;

  return {
    async complete() {
      calls += 1;

      if (calls === 1) {
        return {
          content: "",
          toolCalls: [
            { id: "t1", name: "git_context", arguments: { op: "diff" } },
          ],
        };
      }

      return {
        content: "",
        toolCalls: [
          {
            id: "t2",
            name: "agent_result",
            arguments: {
              summary: finding === null ? "looks correct" : "found one issue",
              findings:
                finding === null
                  ? []
                  : [
                      {
                        detail: finding.detail,
                        source: finding.source,
                        confidence: "high",
                      },
                    ],
            },
          },
        ],
      };
    },
  };
}

const FINDING = {
  source: "discount.ts:2",
  detail: "subtraction is reversed; returns a negative discount",
};

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
    reviewerStub(FINDING),
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
  // The agent reports no findings ⇒ empty return.
  const findings = await runReviewCommand(
    reviewerStub(null),
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
    reviewerStub(FINDING),
    repo,
    "",
    (s) => {
      printed += s;
    },
    80
  );

  expect(printed).toContain("subtraction is reversed");
});
