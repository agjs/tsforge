import { test, expect } from "bun:test";
import { doGithubRead } from "../src/loop/tools/github-ops";
import type { IVcsDeps } from "../src/loop/tools/vcs-common";
import type { IToolContext } from "../src/loop/tools";

const ctx = (): IToolContext => ({
  cwd: "/repo",
  files: [],
  report: () => {},
  task: "t",
  github: true,
});

interface IRun {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

/** A fake argv runner that matches on a substring of the joined argv and returns
 *  canned output. Records every argv it saw for exact-shape assertions. */
function fakeRunner(routes: [string, IRun][]): {
  deps: IVcsDeps;
  seen: string[][];
} {
  const seen: string[][] = [];

  const deps: IVcsDeps = {
    run: async (_cwd, argv) => {
      seen.push(argv);
      const joined = argv.join(" ");
      const hit = routes.find(([needle]) => joined.includes(needle));
      const r = hit?.[1] ?? {};

      return {
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        exitCode: r.exitCode ?? 0,
        timedOut: false,
      };
    },
  };

  return { deps, seen };
}

test("pr_view formats the PR summary from --json", async () => {
  const { deps, seen } = fakeRunner([
    [
      "pr view",
      {
        stdout: JSON.stringify({
          number: 12,
          title: "Fix the flaky test",
          state: "OPEN",
          isDraft: false,
          headRefName: "fix-flaky",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          reviewDecision: "REVIEW_REQUIRED",
          url: "https://github.com/o/r/pull/12",
        }),
      },
    ],
  ]);

  const out = await doGithubRead({ op: "pr_view" }, ctx(), deps);

  expect(out).toContain("#12 Fix the flaky test");
  expect(out).toContain("fix-flaky → main");
  expect(out).toContain("REVIEW_REQUIRED");
  expect(out).toContain("https://github.com/o/r/pull/12");
  // exact shape: uses the JSON view, not the human view
  expect(seen[0]).toContain("--json");
});

test("checks renders per-check status and tolerates a non-zero exit", async () => {
  const { deps } = fakeRunner([
    [
      "pr checks",
      {
        // gh exits non-zero while checks are pending/failing — must still parse
        exitCode: 8,
        stdout: JSON.stringify([
          { name: "build", state: "SUCCESS", bucket: "pass", link: "" },
          { name: "e2e", state: "FAILURE", bucket: "fail", link: "" },
          { name: "lint", state: "IN_PROGRESS", bucket: "pending", link: "" },
        ]),
      },
    ],
  ]);

  const out = await doGithubRead({ op: "checks" }, ctx(), deps);

  expect(out).toContain("✓ build");
  expect(out).toContain("✗ e2e");
  expect(out).toContain("… lint");
});

test("failing_logs resolves branch → run id → failing log, tail-capped", async () => {
  const bigLog = `${"x".repeat(9000)}\nFATAL: the real error is here`;
  const { deps, seen } = fakeRunner([
    ["rev-parse --abbrev-ref HEAD", { stdout: "my-branch\n" }],
    [
      "run list",
      {
        stdout: JSON.stringify([
          { databaseId: 555, conclusion: "failure", status: "completed" },
        ]),
      },
    ],
    ["run view 555 --log-failed", { stdout: bigLog }],
  ]);

  const out = await doGithubRead(
    { op: "failing_logs", maxChars: 200 },
    ctx(),
    deps
  );

  expect(out).toContain("FATAL: the real error is here");
  expect(out).toContain("showing the tail");
  // used the resolved branch in the run-list query
  expect(seen.some((a) => a.includes("my-branch"))).toBe(true);
});

test("review_threads returns only UNRESOLVED threads with their resolve ids", async () => {
  const graphql = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "THREAD_RESOLVED",
                isResolved: true,
                path: "a.ts",
                line: 1,
                comments: {
                  nodes: [{ author: { login: "copilot" }, body: "done" }],
                },
              },
              {
                id: "THREAD_OPEN",
                isResolved: false,
                path: "b.ts",
                line: 42,
                comments: {
                  nodes: [
                    {
                      author: { login: "reviewer" },
                      body: "please rename this",
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  });

  const { deps, seen } = fakeRunner([
    ["repo view", { stdout: JSON.stringify({ nameWithOwner: "o/r" }) }],
    ["pr view", { stdout: JSON.stringify({ number: 7 }) }],
    ["api graphql", { stdout: graphql }],
  ]);

  const out = await doGithubRead({ op: "review_threads" }, ctx(), deps);

  expect(out).toContain("THREAD_OPEN");
  expect(out).toContain("b.ts:42");
  expect(out).toContain("reviewer: please rename this");
  // the resolved thread is filtered out
  expect(out).not.toContain("THREAD_RESOLVED");
  // owner/repo/number were bound to the graphql call
  const gql = seen.find((a) => a.join(" ").includes("api graphql")) ?? [];

  expect(gql.some((t) => t.includes("owner=o"))).toBe(true);
  expect(gql.some((t) => t.includes("number=7"))).toBe(true);
});

test("a missing gh binary degrades to a clear message (exit 127)", async () => {
  const { deps } = fakeRunner([["pr view", { exitCode: 127 }]]);

  const out = await doGithubRead({ op: "pr_view" }, ctx(), deps);

  expect(out).toContain("gh CLI is not installed");
});

test("an unauthenticated gh is reported clearly", async () => {
  const { deps } = fakeRunner([
    ["pr view", { exitCode: 1, stderr: "gh auth login required" }],
  ]);

  const out = await doGithubRead({ op: "pr_view" }, ctx(), deps);

  expect(out).toContain("not authenticated");
});

test("an unsafe pr selector is rejected", async () => {
  const { deps } = fakeRunner([]);

  const out = await doGithubRead(
    { op: "pr_view", pr: "; rm -rf /" },
    ctx(),
    deps
  );

  expect(out).toContain("unsafe");
});

test("unknown op is rejected", async () => {
  const { deps } = fakeRunner([]);

  expect(await doGithubRead({ op: "merge" }, ctx(), deps)).toContain(
    "unknown op"
  );
});
