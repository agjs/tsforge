import {
  mkdir,
  readFile,
  writeFile,
  access,
  copyFile,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";
import { runArgvCommand, type IShellRun } from "../lib/fs/process";
import { pollUntilReady } from "../../scripts/boot-check";

/** Reject a manifest-derived relative path that would escape the destination —
 *  empty, absolute, or containing a `..` segment (either separator). Scaffold
 *  manifest values are semi-trusted: the manifest is read from a CLONED repo,
 *  redirectable via BORINGSTACK_REPO/`--ref`, so every on-disk path built from
 *  it — env files to WRITE, template paths to DELETE — must be contained, or an
 *  `envFile: "../../../.bashrc"` writes (or an unsafe strip deletes) outside the
 *  scaffold destination. Lexical + both separators; the caller joins to `dest`. */
export function assertSafeScaffoldRel(rel: string, verb: string): void {
  if (
    rel.length === 0 ||
    rel.startsWith("/") ||
    rel.startsWith("\\") ||
    rel.split(/[\\/]/u).includes("..")
  ) {
    throw new Error(`scaffold: refusing to ${verb} unsafe path "${rel}"`);
  }
}

/** Runs an explicit argv (no shell) in `cwd`. Matches `runArgvCommand` so the real
 *  adapter is a direct pass-through; tests inject a recording fake to assert the
 *  exact command sequence without spawning git/Docker. */
export type IScaffoldRunner = (
  cwd: string,
  argv: readonly string[]
) => Promise<IShellRun>;

/** Filesystem surface the scaffold I/O needs. Abstracted so configure/clone are
 *  unit-testable against an in-memory map. */
export interface IScaffoldFs {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  /** Recursively delete a path; a no-op if it doesn't exist. */
  remove(path: string): Promise<void>;
}

/** Poll a URL until it answers < 500, or time out. Matches `pollUntilReady`. */
export type IReadyPoller = (
  url: string,
  timeoutMs: number
) => Promise<number | null>;

/** The live adapters wired to the real process/fs/network. */
export const realRunner: IScaffoldRunner = (cwd, argv) =>
  runArgvCommand(cwd, [...argv]);

export const realFs: IScaffoldFs = {
  async exists(path) {
    try {
      await access(path);

      return true;
    } catch {
      return false;
    }
  },
  readText: (path) => readFile(path, "utf8"),
  async writeText(path, content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  },
  copy: (from, to) => copyFile(from, to),
  remove: (path) => rm(path, { recursive: true, force: true }),
};

export const realPoller: IReadyPoller = (url, timeoutMs) =>
  pollUntilReady(url, timeoutMs);
