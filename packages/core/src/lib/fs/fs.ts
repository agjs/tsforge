import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
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

/** In a dependency/build/vcs dir we never read OR mutate (so never tombstone). */
function inIgnoredDir(rel: string): boolean {
  return rel.split("/").some((seg) => IGNORE_SEGMENTS.has(seg));
}

function ignored(rel: string): boolean {
  return inIgnoredDir(rel) || BINARY_EXT.test(rel);
}

/** Expand a glob scope to the concrete files under `cwd` (sorted), capped at
 *  `limit` (default MAX_GLOB_FILES — the prompt-safety bound; pass `Infinity` when
 *  completeness matters more than prompt size). `skip` decides what to exclude:
 *  the default drops ignored dirs AND binaries (prompt/context use); rollback
 *  passes `inIgnoredDir` so it still SEES created assets (`.svg`, images) it must
 *  delete — filtering those out would leave them behind on a revert. */
async function expandGlob(
  cwd: string,
  pattern: string,
  limit = MAX_GLOB_FILES,
  skip: (rel: string) => boolean = ignored
): Promise<string[]> {
  const found: string[] = [];

  for await (const rel of new Glob(pattern).scan({ cwd, onlyFiles: true })) {
    if (!skip(rel)) {
      found.push(rel);
    }

    if (found.length >= limit) {
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

      // Record BEFORE writing: a write that truncates-then-throws (disk full)
      // must still be rolled back to `prior`, so the entry has to exist already.
      done.push({ abs, prior });
      await Bun.write(abs, file.content);
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
  paths: readonly string[],
  limit = MAX_GLOB_FILES
): Promise<string[]> {
  const out = new Set<string>();

  for (const path of paths) {
    if (isGlobPattern(path)) {
      for (const match of await expandGlob(cwd, path, limit)) {
        out.add(match);
      }
    } else {
      out.add(path);
    }
  }

  return [...out];
}

/**
 * Resolve a scope for ROLLBACK: every file under `cwd` (uncapped) excluding only
 * ignored dirs (node_modules, dist, .git…) — but INCLUDING binaries/assets the
 * prompt-facing resolver drops. A failed repair can create `icon.svg` under a
 * `**\/*` scope; rollback must see it to delete it, or it reports "reverted" while
 * leaving the file behind. Separate from `resolveScopeFiles` precisely so the
 * prompt/context filtering never silently narrows what a revert can clean up.
 */
export async function resolveScopeFilesForRollback(
  cwd: string,
  paths: readonly string[]
): Promise<string[]> {
  const out = new Set<string>();

  for (const path of paths) {
    if (isGlobPattern(path)) {
      const matches = await expandGlob(
        cwd,
        path,
        Number.POSITIVE_INFINITY,
        inIgnoredDir
      );

      for (const match of matches) {
        out.add(match);
      }
    } else {
      out.add(path);
    }
  }

  return [...out];
}

/**
 * All readable workspace files (same scope as the glob expansion above), ordered
 * MOST-RECENTLY-MODIFIED first. This is the source for the `@` file picker: a
 * recency order means the files you're actually working on surface at the top
 * instead of an alphabetical dump of the whole tree. Unstattable files sort last.
 */
export async function listWorkspaceFiles(cwd: string): Promise<string[]> {
  const files = await resolveScopeFiles(cwd, ["**/*"]);

  const stamped = await Promise.all(
    files.map(async (path) => {
      try {
        return { path, mtimeMs: (await stat(join(cwd, path))).mtimeMs };
      } catch {
        return { path, mtimeMs: 0 };
      }
    })
  );

  return stamped.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.path);
}
