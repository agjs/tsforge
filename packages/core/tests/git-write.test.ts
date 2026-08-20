import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doGitWrite } from "../src/loop/tools/git-write-ops";
import type { IToolContext } from "../src/loop/tools";

const ctx = (cwd: string, github = true): IToolContext => ({
  cwd,
  files: [],
  report: () => {},
  task: "t",
  github,
});

const git = (cwd: string, ...argv: string[]): string =>
  execFileSync("git", argv, { cwd }).toString().trim();

let repo: string;
let remote: string;

beforeEach(() => {
  remote = mkdtempSync(join(tmpdir(), "tsforge-remote-"));
  execFileSync("git", ["init", "--bare", "-q", remote]);

  repo = mkdtempSync(join(tmpdir(), "tsforge-gitw-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "initial");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

test("branch creates and switches to a new branch", async () => {
  const out = await doGitWrite({ op: "branch", name: "feature-x" }, ctx(repo));

  expect(out).not.toContain("failed");
  expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature-x");
});

test("checkout switches back to an existing branch", async () => {
  await doGitWrite({ op: "branch", name: "feature-y" }, ctx(repo));

  await doGitWrite({ op: "checkout", name: "main" }, ctx(repo));

  expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

test("commit stages the named paths and records the message", async () => {
  writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");

  const out = await doGitWrite(
    { op: "commit", paths: ["b.ts"], message: "add b" },
    ctx(repo)
  );

  expect(out).not.toContain("failed");
  expect(git(repo, "log", "-1", "--pretty=%s")).toBe("add b");
  expect(git(repo, "show", "--stat", "HEAD")).toContain("b.ts");
});

test("commit with all:true stages every change", async () => {
  writeFileSync(join(repo, "a.ts"), "export const a = 42;\n");
  writeFileSync(join(repo, "c.ts"), "export const c = 3;\n");

  await doGitWrite({ op: "commit", all: true, message: "sweep" }, ctx(repo));

  expect(git(repo, "log", "-1", "--pretty=%s")).toBe("sweep");
  expect(git(repo, "status", "--porcelain")).toBe("");
});

test("commit needs a message", async () => {
  writeFileSync(join(repo, "d.ts"), "export const d = 4;\n");

  const out = await doGitWrite({ op: "commit", paths: ["d.ts"] }, ctx(repo));

  expect(out).toContain("message");
});

test("commit needs paths or all:true", async () => {
  const out = await doGitWrite({ op: "commit", message: "nothing" }, ctx(repo));

  expect(out).toContain("paths");
});

test("push -u sends the current branch to the bare remote", async () => {
  await doGitWrite({ op: "branch", name: "pushme" }, ctx(repo));
  writeFileSync(join(repo, "e.ts"), "export const e = 5;\n");
  await doGitWrite({ op: "commit", all: true, message: "e" }, ctx(repo));

  const out = await doGitWrite({ op: "push", setUpstream: true }, ctx(repo));

  expect(out).not.toContain("failed");
  // the branch now exists on the remote
  expect(git(remote, "branch", "--list", "pushme")).toContain("pushme");
});

test("fails closed when the github capability is off", async () => {
  const out = await doGitWrite(
    { op: "branch", name: "nope" },
    ctx(repo, false)
  );

  expect(out).toContain("capability is off");
  // no branch was created
  expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

test("rejects an unsafe branch name (option injection)", async () => {
  expect(
    await doGitWrite({ op: "branch", name: "--upload-pack=evil" }, ctx(repo))
  ).toContain("safe `name`");
  expect(
    await doGitWrite({ op: "branch", name: "a; rm -rf /" }, ctx(repo))
  ).toContain("safe `name`");
});

test("rejects an unsafe path in commit", async () => {
  const out = await doGitWrite(
    { op: "commit", paths: ["ok.ts", "; rm -rf /"], message: "x" },
    ctx(repo)
  );

  expect(out).toContain("unsafe path");
});

test("unknown op is rejected", async () => {
  expect(await doGitWrite({ op: "rebase" }, ctx(repo))).toContain("unknown op");
});
