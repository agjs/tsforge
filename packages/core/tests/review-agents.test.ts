import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import type { ILoopEvent } from "../src/loop";
import {
  reviewAgents,
  findingsFrom,
  locate,
} from "../src/loop/review/review-agents";

// ── pure mapping (no runner) ────────────────────────────────────────────────

test("locate parses file:line, tolerates ranges, drops sourceless", () => {
  expect(locate("src/a.ts:42")).toEqual({ file: "src/a.ts", line: 42 });
  expect(locate("src/a.ts:42-50")).toEqual({ file: "src/a.ts", line: 42 });
  expect(locate("no line here")).toBeNull();
  expect(locate(undefined)).toBeNull();
  expect(locate("https://example.com")).toBeNull();
});

test("findingsFrom maps confidence→severity and DROPS findings with no file:line", () => {
  const { findings, dropped } = findingsFrom({
    summary: "s",
    findings: [
      {
        detail: "SQL built from user input",
        source: "src/db.ts:10",
        confidence: "high",
      },
      { detail: "maybe slow", source: "src/x.ts:3", confidence: "low" },
      { detail: "no source ⇒ not grounded" }, // dropped
      { detail: "medium default", source: "src/y.ts:7" },
    ],
  });

  expect(findings).toHaveLength(3);
  expect(dropped).toBe(1);
  expect(findings[0]).toMatchObject({
    file: "src/db.ts",
    line: 10,
    severity: "error",
  });
  expect(findings[1]?.severity).toBe("info");
  expect(findings[2]?.severity).toBe("warning"); // no confidence → warning
});

test("findingsFrom tolerates a non-structured payload", () => {
  expect(findingsFrom(undefined).findings).toHaveLength(0);
  expect(findingsFrom("nope").findings).toHaveLength(0);
});

// ── end-to-end: a stub-driven review agent over a real temp repo ─────────────

/** A provider that drives one review agent: first call → investigate (a read-only
 *  tool the runner requires before accepting a result), then → agent_result. */
function reviewerStub(source: string): IProvider {
  let calls = 0;

  return {
    async complete() {
      calls += 1;

      if (calls === 1) {
        // investigate first (git_context diff) so the runner accepts the result
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
              summary: "found one issue",
              findings: [
                {
                  detail:
                    "the subtraction is reversed, returns a negative value",
                  source,
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

let repo: string;
const git = (...a: string[]): void =>
  void execFileSync("git", a, { cwd: repo, stdio: "ignore" });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "tsforge-revagents-"));
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

test("runs a review AGENT that investigates then reports a grounded finding", async () => {
  const report = await reviewAgents(reviewerStub("discount.ts:2"), repo);

  expect(report.changedFiles).toContain("discount.ts");
  expect(report.findings).toHaveLength(1);
  expect(report.findings[0]).toMatchObject({
    file: "discount.ts",
    line: 2,
    severity: "error",
  });
});

test("a panel of reviewers runs and pools + dedups the same finding", async () => {
  const events: ILoopEvent[] = [];
  const report = await reviewAgents(reviewerStub("discount.ts:2"), repo, {
    reviewProviders: [
      reviewerStub("discount.ts:2"),
      reviewerStub("discount.ts:2"), // same spot → deduped to one
    ],
    concurrency: 2,
    onEvent: (e) => events.push(e),
  });

  expect(report.findings).toHaveLength(1); // deduped
  // each reviewer rendered as a live node (spawned + result)
  const spawned = events.filter((e) => e.kind === "agent_spawned");
  const results = events.filter((e) => e.kind === "agent_result");

  expect(spawned).toHaveLength(2);
  expect(results).toHaveLength(2);
});

test("no changed files → empty report, no agents", async () => {
  git("add", "-A");
  git("commit", "-q", "-m", "commit it");
  const report = await reviewAgents(reviewerStub("x.ts:1"), repo);

  expect(report.changedFiles).toHaveLength(0);
  expect(report.findings).toHaveLength(0);
});

test("a failed reviewer is surfaced on the report when another succeeds", async () => {
  const failing: IProvider = {
    async complete() {
      throw new Error("reviewer down");
    },
  };

  const report = await reviewAgents(reviewerStub("discount.ts:2"), repo, {
    reviewProviders: [failing, reviewerStub("discount.ts:2")],
    concurrency: 2,
  });

  expect(report.findings).toHaveLength(1);
  expect(report.failedReviewers).toEqual(["reviewer 1"]);
});
