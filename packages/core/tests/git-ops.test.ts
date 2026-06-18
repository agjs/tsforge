import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doGit } from "../src/loop/tools/git-ops";
import { READ_ONLY_TOOL_NAMES } from "../src/agent";
import type { IToolContext } from "../src/loop/tools";

const ctx = (cwd: string): IToolContext => ({
  cwd,
  files: [],
  report: () => {},
  task: "t",
});

const git = (cwd: string, ...argv: string[]): void => {
  execFileSync("git", argv, { cwd, stdio: "ignore" });
};

let repo: string;
let firstSha: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "tsforge-git-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  // Don't inherit a global commit.gpgsign=true — signing via an unavailable agent
  // (e.g. a locked 1Password) would make the temp-repo commits fail spuriously.
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(
    join(repo, "a.ts"),
    "export const a = 1;\nexport const b = 2;\n"
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "initial");
  firstSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
    .toString()
    .trim();
  // an uncommitted working change for diff/changed_files
  writeFileSync(
    join(repo, "a.ts"),
    "export const a = 99;\nexport const b = 2;\n"
  );
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("diff reflects the working-tree change", async () => {
  const out = await doGit({ op: "diff" }, ctx(repo));

  expect(out).toContain("a.ts");
  expect(out).toContain("-export const a = 1;");
  expect(out).toContain("+export const a = 99;");
});

test("changed_files lists the modified file with numstat", async () => {
  const out = await doGit({ op: "changed_files" }, ctx(repo));

  expect(out).toContain("a.ts");
});

test("log returns the commit subject", async () => {
  const out = await doGit({ op: "log", max: 5 }, ctx(repo));

  expect(out).toContain("initial");
});

test("show returns a commit by sha", async () => {
  const out = await doGit({ op: "show", sha: firstSha }, ctx(repo));

  expect(out).toContain("initial");
  expect(out).toContain("a.ts");
});

test("blame attributes a line range", async () => {
  const out = await doGit(
    { op: "blame", path: "a.ts", lineStart: 1, lineEnd: 2 },
    ctx(repo)
  );

  expect(out.toLowerCase()).toContain("export const");
});

test("rejects shell metacharacters and option injection", async () => {
  expect(await doGit({ op: "diff", path: "; rm -rf /" }, ctx(repo))).toContain(
    "unsafe path"
  );
  expect(
    await doGit({ op: "diff", ref: "--upload-pack=evil" }, ctx(repo))
  ).toContain("unsafe ref");
  expect(await doGit({ op: "show", sha: "$(touch x)" }, ctx(repo))).toContain(
    "valid `sha`"
  );
  // whitespace-prefixed option must not slip past the leading-dash guard
  expect(
    await doGit({ op: "diff", ref: "  --upload-pack=evil" }, ctx(repo))
  ).toContain("unsafe ref");
});

test("blame tolerates a reversed line range", async () => {
  const out = await doGit(
    { op: "blame", path: "a.ts", lineStart: 2, lineEnd: 1 },
    ctx(repo)
  );

  expect(out.toLowerCase()).toContain("export const");
});

test("unknown op is rejected", async () => {
  expect(await doGit({ op: "push" }, ctx(repo))).toContain("unknown op");
});

test("maxChars truncates with a note", async () => {
  const out = await doGit({ op: "diff", maxChars: 10 }, ctx(repo));

  expect(out).toContain("truncated");
  // 10 chars of body + the truncation note
  expect(out.split("\n")[0]?.length).toBeLessThanOrEqual(10);
});

test("a non-git directory degrades to a clear message, no throw", async () => {
  const bare = mkdtempSync(join(tmpdir(), "tsforge-nogit-"));

  try {
    expect(await doGit({ op: "diff" }, ctx(bare))).toContain(
      "not a git repository"
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("git_context is a plan-mode (read-only) tool", () => {
  expect(READ_ONLY_TOOL_NAMES.has("git_context")).toBe(true);
});
