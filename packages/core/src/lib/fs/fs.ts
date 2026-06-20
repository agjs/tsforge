import { join } from "node:path";
import { rm } from "node:fs/promises";
import { Glob } from "bun";
import type { IFileView } from "./fs.types";

/** True when the file exists on disk (the one place this check lives). */
export function fileExists(cwd: string, path: string): Promise<boolean> {
  return Bun.file(join(cwd, path)).exists();
}

/** Directory segments never worth reading into context (deps, build output, vcs). */
const IGNORE_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".vite",
]);
/** Skip files bigger than this — generated bundles, fixtures, data blobs. */
const MAX_FILE_BYTES = 131_072;
/** Bound a glob scan so a huge tree can't blow up context (the MAP handles the
 *  rest — see renderFileSection). */
const MAX_GLOB_FILES = 400;
/** Binary-ish extensions: reading these as text is meaningless. */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|svg|pdf|woff2?|ttf|eot|mp[34]|mov|zip|gz|tar|wasm|lockb|node|bin)$/i;

function isGlobPattern(path: string): boolean {
  return /[*?[\]{}]/.test(path);
}

function ignored(rel: string): boolean {
  return (
    rel.split("/").some((seg) => IGNORE_SEGMENTS.has(seg)) ||
    BINARY_EXT.test(rel)
  );
}

/** Expand a glob scope to the concrete, readable files under `cwd` (sorted),
 *  skipping ignored dirs and binary files, capped at MAX_GLOB_FILES. */
async function expandGlob(cwd: string, pattern: string): Promise<string[]> {
  const found: string[] = [];

  for await (const rel of new Glob(pattern).scan({ cwd, onlyFiles: true })) {
    if (!ignored(rel)) {
      found.push(rel);
    }

    if (found.length >= MAX_GLOB_FILES) {
      break;
    }
  }

  return found.sort();
}

/**
 * Read the given scope entries as {path, content} views. A literal path is read
 * directly; a GLOB (any entry with `*`/`?`/brackets, e.g. a recursive `src` star
 * pattern) is expanded to the matching files under `cwd` — without this, a glob
 * scope reads as zero files and a real project gets misclassified as an empty
 * scratch dir. Skips files over MAX_FILE_BYTES and de-dupes when patterns overlap.
 */
export async function readFiles(
  cwd: string,
  paths: readonly string[]
): Promise<IFileView[]> {
  const views: IFileView[] = [];
  const seen = new Set<string>();

  const take = async (path: string): Promise<void> => {
    if (seen.has(path)) {
      return;
    }

    seen.add(path);

    const file = Bun.file(join(cwd, path));

    if ((await file.exists()) && file.size <= MAX_FILE_BYTES) {
      views.push({ path, content: await file.text() });
    }
  };

  for (const path of paths) {
    if (isGlobPattern(path)) {
      for (const match of await expandGlob(cwd, path)) {
        await take(match);
      }
    } else {
      await take(path);
    }
  }

  return views;
}

/** One pending write in a batch. */
export interface IWriteFile {
  path: string;
  content: string;
}

/** Result of a batch write: the paths written on success, or the failure reason. */
export type IBatchWriteResult =
  | { ok: true; written: string[] }
  | { ok: false; reason: string };

/** A file touched by the batch, with the bytes to restore it to on rollback
 *  (`null` = it didn't exist before, so rollback removes it). */
interface ITouched {
  abs: string;
  prior: Uint8Array | null;
}

/** Best-effort restore of a partial batch, newest first: bring each touched path
 *  back to its prior bytes, or remove it if it didn't exist before. A rollback
 *  failure is swallowed so it can't mask the original write error. */
async function rollback(done: readonly ITouched[]): Promise<void> {
  for (const entry of [...done].reverse()) {
    try {
      await (entry.prior === null
        ? rm(entry.abs, { force: true })
        : Bun.write(entry.abs, entry.prior));
    } catch {
      // best-effort
    }
  }
}

/**
 * Write a batch of files ATOMICALLY: either all land, or NONE do. On any write
 * failure (e.g. EACCES), every file already written in THIS batch is rolled back
 * — a path that existed is RESTORED to its previous bytes (never deleted), one
 * that didn't is removed — so a partial mutation never reaches disk. This is the
 * contract the scaffolds + semantic edits rely on to emit `mutated` only once,
 * after a full success. Parent dirs are created as needed (via `Bun.write`).
 */
export async function writeFilesOrRollback(
  cwd: string,
  files: readonly IWriteFile[]
): Promise<IBatchWriteResult> {
  const done: ITouched[] = [];

  try {
    for (const file of files) {
      const abs = join(cwd, file.path);
      const handle = Bun.file(abs);
      const prior = (await handle.exists())
        ? new Uint8Array(await handle.arrayBuffer())
        : null;

      await Bun.write(abs, file.content);
      done.push({ abs, prior });
    }

    return { ok: true, written: files.map((f) => f.path) };
  } catch (err) {
    await rollback(done);

    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolve a scope (literal paths + globs) to the concrete file paths it covers,
 * de-duped. Literal entries pass through as-is; a glob entry (any `*`/`?`/bracket
 * pattern, e.g. a recursive `src` tree) expands to matching files under `cwd`.
 * Use this anywhere code iterates an editable scope by path — e.g. the
 * deterministic fixers — so a glob scope isn't silently skipped (a literal
 * `fileExists` on a glob pattern is always false).
 */
export async function resolveScopeFiles(
  cwd: string,
  paths: readonly string[]
): Promise<string[]> {
  const out = new Set<string>();

  for (const path of paths) {
    if (isGlobPattern(path)) {
      for (const match of await expandGlob(cwd, path)) {
        out.add(match);
      }
    } else {
      out.add(path);
    }
  }

  return [...out];
}
