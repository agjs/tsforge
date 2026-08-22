import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureDirtyBaseline,
  detectDirtyPackageRoots,
  rememberNewChildren,
} from "../src/gate/dirty-packages";
import { runArgvCommand } from "../src/lib/fs";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await runArgvCommand(cwd, ["git", ...args], { timeoutMs: 15_000 });

  expect(r.exitCode).toBe(0);
}

/** A committed-clean child package repo. */
async function gitChild(container: string, name: string): Promise<string> {
  const dir = join(container, name);

  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name }));
  await writeFile(join(dir, "src", "index.ts"), "export const n = 1;\n");
  await git(dir, "init", "-q");
  await git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  await git(
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "init"
  );

  return dir;
}

describe("dirty-packages — git-baseline detection (the FG-1 seam)", () => {
  test("a direct write (the sed -i shape) is detected; a clean sibling is not", async () => {
    const container = await mkdtemp(join(tmpdir(), "tsforge-dirty-"));

    try {
      const api = await gitChild(container, "api");
      const app = await gitChild(container, "app");
      const baseline = await captureDirtyBaseline([api, app]);

      // The model writes through the SHELL — no edit/create tool event exists.
      await writeFile(
        join(api, "src", "index.ts"),
        'export const n: number = "boom";\n'
      );

      const d = await detectDirtyPackageRoots(
        [api, app],
        baseline,
        Date.now() - 60_000
      );

      expect(d.dirty).toEqual([api]);
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  }, 30_000);

  test("a write followed by a COMMIT inside the child still counts (HEAD moved)", async () => {
    const container = await mkdtemp(join(tmpdir(), "tsforge-dirty-commit-"));

    try {
      const api = await gitChild(container, "api");
      const baseline = await captureDirtyBaseline([api]);

      await writeFile(join(api, "src", "index.ts"), "export const n = 2;\n");
      await git(api, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
      await git(
        api,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-qm",
        "hide"
      );

      // git status is clean again — only the HEAD hash betrays the change.
      const d = await detectDirtyPackageRoots([api], baseline, Date.now());

      expect(d.dirty).toEqual([api]);
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  }, 30_000);

  test("a pre-existing dirty tree is NOT dragged in (baseline diffing, not absolute dirtiness)", async () => {
    const container = await mkdtemp(join(tmpdir(), "tsforge-dirty-pre-"));

    try {
      const api = await gitChild(container, "api");

      // User's own uncommitted change EXISTS BEFORE the session baseline.
      await writeFile(join(api, "src", "wip.ts"), "export const wip = 1;\n");

      const baseline = await captureDirtyBaseline([api]);
      const d = await detectDirtyPackageRoots([api], baseline, Date.now());

      expect(d.dirty).toEqual([]);
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  });

  test("non-git child falls back to mtime; new children are dirty until remembered", async () => {
    const container = await mkdtemp(join(tmpdir(), "tsforge-dirty-nogit-"));

    try {
      const plain = join(container, "plain");

      await mkdir(join(plain, "src"), { recursive: true });
      await writeFile(
        join(plain, "package.json"),
        JSON.stringify({ name: "p" })
      );
      await writeFile(join(plain, "src", "index.ts"), "export const n = 1;\n");

      const baseline = await captureDirtyBaseline([plain]);
      const sinceMs = Date.now();

      // Untouched → clean.
      expect(
        (await detectDirtyPackageRoots([plain], baseline, sinceMs)).dirty
      ).toEqual([]);

      // Shell-written after sinceMs → dirty via mtime.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(join(plain, "src", "index.ts"), "export const n = 2;\n");
      expect(
        (await detectDirtyPackageRoots([plain], baseline, sinceMs)).dirty
      ).toEqual([plain]);

      // A child with NO baseline entry (appeared mid-session) is dirty by
      // definition, then diffs once remembered.
      const fresh = await gitChild(container, "fresh");
      const d = await detectDirtyPackageRoots([fresh], baseline, sinceMs);

      expect(d.dirty).toEqual([fresh]);
      expect(d.notices.some((n) => n.includes("appeared"))).toBe(true);

      await rememberNewChildren(baseline, [fresh]);
      expect(
        (await detectDirtyPackageRoots([fresh], baseline, sinceMs)).dirty
      ).toEqual([]);
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  });
});
