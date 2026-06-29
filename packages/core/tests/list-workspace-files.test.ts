import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkspaceFiles } from "../src/lib/fs";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tsforge-lwf-"));

  // Write three files, then stamp distinct mtimes (oldest → newest).
  for (const name of ["old.ts", "mid.ts", "new.ts"]) {
    await writeFile(join(dir, name), "export const x = 1;\n");
  }

  await utimes(join(dir, "old.ts"), new Date(1_000), new Date(1_000));
  await utimes(join(dir, "mid.ts"), new Date(2_000), new Date(2_000));
  await utimes(join(dir, "new.ts"), new Date(3_000), new Date(3_000));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("listWorkspaceFiles: orders most-recently-modified first (non-git glob fallback)", async () => {
  expect(await listWorkspaceFiles(dir)).toEqual(["new.ts", "mid.ts", "old.ts"]);
});

test("listWorkspaceFiles: in a git repo, respects .gitignore (no hardcoded names)", async () => {
  const repo = await mkdtemp(join(tmpdir(), "tsforge-lwf-git-"));

  const git = (args: string[]): void => {
    Bun.spawnSync(["git", ...args], { cwd: repo });
  };

  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);

  await writeFile(join(repo, ".gitignore"), "ignored.log\nbuild/\n");
  await writeFile(join(repo, "keep.ts"), "export const x = 1;\n");
  await writeFile(join(repo, "ignored.log"), "junk\n");
  await mkdir(join(repo, "build"), { recursive: true });
  await writeFile(join(repo, "build", "out.js"), "junk\n");
  git(["add", "-A"]);

  // A brand-new, never-added file that is NOT ignored — must still show (--others).
  await writeFile(join(repo, "untracked.ts"), "export const y = 2;\n");

  const files = await listWorkspaceFiles(repo);

  expect(files).toContain("keep.ts"); // tracked source
  expect(files).toContain("untracked.ts"); // untracked but not ignored
  expect(files).not.toContain("ignored.log"); // gitignored → gone, no denylist needed
  expect(files).not.toContain("build/out.js"); // ignored dir → gone

  await rm(repo, { recursive: true, force: true });
});
