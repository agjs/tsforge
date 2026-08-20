import { test, expect } from "bun:test";
import { doGithubWrite, lintPrBody } from "../src/loop/tools/github-ops";
import type { IVcsDeps } from "../src/loop/tools/vcs-common";
import type { IToolContext } from "../src/loop/tools";

const ctx = (github = true): IToolContext => ({
  cwd: "/repo",
  files: [],
  report: () => {},
  task: "t",
  github,
});

interface IRun {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

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

const GOOD_BODY =
  "Reviewers kept hitting a flaky test. This makes the wait deterministic so CI stops failing at random.";

test("fails closed when the github capability is off", async () => {
  const { deps, seen } = fakeRunner([]);

  const out = await doGithubWrite(
    { op: "pr_create", title: "t", body: GOOD_BODY, base: "main" },
    ctx(false),
    deps
  );

  expect(out).toContain("capability is off");
  // never shelled out to gh
  expect(seen.length).toBe(0);
});

test("pr_create passes title/body/base and returns the PR url", async () => {
  const { deps, seen } = fakeRunner([
    ["pr create", { stdout: "https://github.com/o/r/pull/9\n" }],
  ]);

  const out = await doGithubWrite(
    { op: "pr_create", title: "Fix flaky test", body: GOOD_BODY, base: "main" },
    ctx(),
    deps
  );

  expect(out).toContain("https://github.com/o/r/pull/9");
  const argv = seen[0] ?? [];

  expect(argv).toContain("--title");
  expect(argv).toContain("Fix flaky test");
  expect(argv).toContain("--base");
  expect(argv).toContain("main");
});

test("pr_create with draft adds --draft", async () => {
  const { deps, seen } = fakeRunner([["pr create", { stdout: "url\n" }]]);

  await doGithubWrite(
    { op: "pr_create", title: "t", body: GOOD_BODY, base: "main", draft: true },
    ctx(),
    deps
  );

  expect(seen[0]).toContain("--draft");
});

test("pr_create rejects an empty body (human-readable guidance)", async () => {
  const { deps, seen } = fakeRunner([]);

  const out = await doGithubWrite(
    { op: "pr_create", title: "t", body: "  ", base: "main" },
    ctx(),
    deps
  );

  expect(out).toContain("empty");
  expect(seen.length).toBe(0);
});

test("pr_create nudges away from line/file-count bodies", async () => {
  const { deps } = fakeRunner([]);

  const out = await doGithubWrite(
    {
      op: "pr_create",
      title: "t",
      body: "Changed 42 lines across 3 files.",
      base: "main",
    },
    ctx(),
    deps
  );

  expect(out).toContain("line/file counts");
});

test("resolve_thread issues the graphql mutation with the thread id", async () => {
  const { deps, seen } = fakeRunner([
    [
      "api graphql",
      {
        stdout: JSON.stringify({
          data: {
            resolveReviewThread: { thread: { id: "T_1", isResolved: true } },
          },
        }),
      },
    ],
  ]);

  const out = await doGithubWrite(
    { op: "resolve_thread", threadId: "T_1" },
    ctx(),
    deps
  );

  expect(out).toContain("resolved");
  const argv = seen[0] ?? [];

  expect(argv.join(" ")).toContain("resolveReviewThread");
  expect(argv.some((t) => t.includes("id=T_1"))).toBe(true);
});

test("resolve_thread needs a thread id", async () => {
  const { deps } = fakeRunner([]);

  expect(await doGithubWrite({ op: "resolve_thread" }, ctx(), deps)).toContain(
    "threadId"
  );
});

test("pr_comment posts the body", async () => {
  const { deps, seen } = fakeRunner([["pr comment", { stdout: "" }]]);

  const out = await doGithubWrite(
    { op: "pr_comment", body: GOOD_BODY, pr: "9" },
    ctx(),
    deps
  );

  expect(out).toContain("comment added");
  const argv = seen[0] ?? [];

  expect(argv).toContain("9");
  expect(argv).toContain("--body");
});

test("unknown op is rejected", async () => {
  const { deps } = fakeRunner([]);

  expect(await doGithubWrite({ op: "merge" }, ctx(), deps)).toContain(
    "unknown op"
  );
});

test("lintPrBody: accepts a human description, rejects empty + mechanics", () => {
  expect(lintPrBody(GOOD_BODY)).toBeNull();
  expect(lintPrBody("")).toContain("empty");
  expect(lintPrBody("added 10 lines")).toContain("line/file");
});
