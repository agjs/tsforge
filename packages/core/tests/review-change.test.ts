import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderReport,
  formatReport,
  detectBase,
  collectChangedFiles,
} from "../src/loop/review/review-change";
import type { IReviewReport } from "../src/loop/review/review.types";
import { runArgvCommand } from "../src/lib/fs";

const BASE_REPORT: IReviewReport = {
  base: "main",
  changedFiles: ["src/a.ts"],
  findings: [
    {
      file: "src/a.ts",
      line: 10,
      severity: "error",
      lens: "logic",
      claim: "off-by-one",
      reason: "loop reads one past the array end",
      verified: true,
      verdict: "confirmed",
    },
  ],
  rejected: 0,
};

test("renderReport(json=true) emits the report as a single JSON line, not the text format", () => {
  const out = renderReport(BASE_REPORT, true);

  expect(out).not.toContain("\n");
  expect(JSON.parse(out)).toEqual(BASE_REPORT);
});

test("renderReport(json=false) falls through to formatReport, unchanged", () => {
  expect(renderReport(BASE_REPORT, false)).toBe(formatReport(BASE_REPORT));
});

test("renderReport(json=true) round-trips an empty-findings report too", () => {
  const empty: IReviewReport = { ...BASE_REPORT, findings: [] };
  const out = renderReport(empty, true);

  expect(JSON.parse(out)).toEqual(empty);
});

/** Runs a git command against a real temp repo, throwing with stderr context
 *  on a nonzero exit — used only to set up test repos. */
async function runGit(cwd: string, argv: string[]): Promise<string> {
  const res = await runArgvCommand(cwd, ["git", ...argv]);

  if (res.exitCode !== 0) {
    throw new Error(
      `git ${argv.join(" ")} failed in ${cwd} (exit ${res.exitCode}): ${res.stderr}`
    );
  }

  return res.stdout;
}

async function initRepo(dir: string): Promise<void> {
  await runGit(dir, ["init", "-q", "-b", "master"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
  await runGit(dir, ["config", "user.name", "Test"]);
}

async function commitFile(
  dir: string,
  name: string,
  contents: string,
  message: string
): Promise<void> {
  await Bun.write(join(dir, name), contents);
  await runGit(dir, ["add", name]);
  await runGit(dir, ["commit", "-q", "-m", message]);
}

// Confirmed against a real GitHub Actions run (app.dreamdata.io, PR #8750):
// `tsforge review --json --base master` reported "No changed source files
// to review." even though the PR plainly added a new .ts file. Root cause:
// after actions/checkout on a PR ref, the runner is left in detached HEAD
// with the base branch never fetched as a LOCAL branch — only
// `origin/master` resolves. detectBase() previously returned the literal
// override unchanged, so collectChangedFiles()'s `git diff master` failed
// (gitText() swallows the error as ""), producing zero changed files.
describe(detectBase.name, () => {
  test("resolves an explicit override that exists as a local branch, unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "detectbase-local-"));

    try {
      await initRepo(dir);
      await commitFile(dir, "a.txt", "hello\n", "init");
      await runGit(dir, ["checkout", "-q", "-b", "feature"]);
      await commitFile(dir, "a.txt", "hello\nworld\n", "add world");

      expect(await detectBase(dir, "master")).toBe("master");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to origin/<override> when the base only exists as a remote-tracking ref (the real actions/checkout shape)", async () => {
    const originDir = await mkdtemp(join(tmpdir(), "detectbase-origin-"));
    const workDir = await mkdtemp(join(tmpdir(), "detectbase-work-"));

    try {
      await initRepo(originDir);
      await commitFile(originDir, "a.txt", "hello\n", "init");

      // Mirrors actions/checkout on a PR ref: clone, detach HEAD, delete the
      // local master branch so only origin/master (remote-tracking) resolves.
      await runGit(tmpdir(), ["clone", "-q", originDir, workDir]);
      await runGit(workDir, ["checkout", "-q", "--detach"]);
      await runGit(workDir, ["branch", "-D", "master"]);
      await commitFile(workDir, "a.txt", "hello\nworld\n", "add world");

      expect(await detectBase(workDir, "master")).toBe("origin/master");
    } finally {
      await rm(originDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("returns the override unchanged when neither the local nor origin/ form resolves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "detectbase-missing-"));

    try {
      await initRepo(dir);
      await commitFile(dir, "a.txt", "hello\n", "init");

      expect(await detectBase(dir, "no-such-branch")).toBe("no-such-branch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("auto-detection also falls back to origin/main when only the remote-tracking ref exists", async () => {
    const originDir = await mkdtemp(join(tmpdir(), "detectbase-auto-origin-"));
    const workDir = await mkdtemp(join(tmpdir(), "detectbase-auto-work-"));

    try {
      await initRepo(originDir);
      await runGit(originDir, ["branch", "-m", "master", "main"]);
      await commitFile(originDir, "a.txt", "hello\n", "init");

      await runGit(tmpdir(), ["clone", "-q", originDir, workDir]);
      await runGit(workDir, ["checkout", "-q", "--detach"]);
      await runGit(workDir, ["branch", "-D", "main"]);
      await commitFile(workDir, "a.txt", "hello\nworld\n", "add world");

      const base = await detectBase(workDir);

      // merge-base(HEAD, origin/main) resolves to the shared "init" commit,
      // not the literal ref string — just confirm it's a real, non-HEAD sha.
      expect(base).not.toBe("HEAD");
      expect(base.length).toBeGreaterThan(0);
    } finally {
      await rm(originDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe(collectChangedFiles.name, () => {
  test("sees a brand-new committed source file against origin/<base> after a checkout-shaped clone", async () => {
    const originDir = await mkdtemp(join(tmpdir(), "changedfiles-origin-"));
    const workDir = await mkdtemp(join(tmpdir(), "changedfiles-work-"));

    try {
      await initRepo(originDir);
      await commitFile(originDir, "a.txt", "hello\n", "init");

      await runGit(tmpdir(), ["clone", "-q", originDir, workDir]);
      await runGit(workDir, ["checkout", "-q", "--detach"]);
      await runGit(workDir, ["branch", "-D", "master"]);
      await commitFile(
        workDir,
        "src/divide.ts",
        "export const x = 1;\n",
        "add divide.ts"
      );

      const base = await detectBase(workDir, "master");
      const { files } = await collectChangedFiles(workDir, base, false);

      expect(files).toEqual(["src/divide.ts"]);
    } finally {
      await rm(originDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
