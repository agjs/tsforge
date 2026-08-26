import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../lib/guards";

/**
 * Read the recorded archetype from a project's `.tsforge/scaffold.json`, or null
 * if absent/unreadable/malformed. Shared by stack adapters so detection keys on
 * the same receipt file. `read` is injectable for tests.
 */
export async function readScaffoldArchetype(
  dir: string,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf-8")
): Promise<string | null> {
  try {
    const raw: unknown = JSON.parse(
      await read(join(dir, ".tsforge", "scaffold.json"))
    );

    return isRecord(raw) && typeof raw.archetype === "string"
      ? raw.archetype
      : null;
  } catch {
    return null;
  }
}

/** I/O for {@link resolveScaffoldedWorkspace}. Default is the real filesystem. */
export interface IScaffoldWorkspaceIo {
  read(path: string): Promise<string>;
  listDirs(path: string): Promise<readonly string[]>;
  hasPackageJson(path: string): Promise<boolean>;
}

const defaultWorkspaceIo: IScaffoldWorkspaceIo = {
  read: (path) => readFile(path, "utf-8"),
  listDirs: async (path) => {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      const names: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          names.push(entry.name);
        }
      }

      return names;
    } catch {
      return [];
    }
  },
  hasPackageJson: (path) =>
    Promise.resolve(existsSync(join(path, "package.json"))),
};

/**
 * The directory the stack adapter should claim. If `dir` itself has a scaffold
 * receipt, that's it. If `dir` is a parent with no package.json and exactly one
 * child that has a receipt (the `/scaffold` dest-under-cwd layout), return that
 * child so a session started in the parent still gets the Phaser/BoringStack
 * harness instead of walking the tree as an unknown repo.
 */
export async function resolveScaffoldedWorkspace(
  dir: string,
  io: IScaffoldWorkspaceIo = defaultWorkspaceIo
): Promise<string> {
  if ((await readScaffoldArchetype(dir, (p) => io.read(p))) !== null) {
    return dir;
  }

  if (await io.hasPackageJson(dir)) {
    return dir;
  }

  const children = await io.listDirs(dir);
  let found: string | null = null;

  for (const name of children) {
    const child = join(dir, name);

    if ((await readScaffoldArchetype(child, (p) => io.read(p))) === null) {
      continue;
    }

    if (found !== null) {
      return dir;
    }

    found = child;
  }

  return found ?? dir;
}
