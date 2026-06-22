import { join } from "node:path";
import { rm } from "node:fs/promises";
import { resolveScopeFiles } from "../lib/fs";

/** Per-file size cap on snapshot CONTENT (matches readFiles' MAX_FILE_BYTES): a
 *  source file we'd ever edit is well under this. Oversize files are still
 *  recorded as pre-existing (so they aren't tombstoned), just not content-backed. */
const MAX_SNAPSHOT_BYTES = 131_072;

/**
 * A rollback point for an "try an edit, keep only if it helps" loop: the contents
 * of every pre-existing file in scope, PLUS the full set of paths that existed at
 * snapshot time (so `restoreFiles` can delete files the attempt newly created —
 * tombstones — not just rewrite edited ones). Carries `cwd`/`scope` so restore
 * needs no extra arguments and can re-list the same scope it captured.
 */
export interface IFileSnapshot {
  cwd: string;
  scope: readonly string[];
  /** Every path that existed in scope at snapshot time (content-backed or not). */
  existed: Set<string>;
  /** Pre-edit contents of the files small enough to back (keyed by rel path). */
  contents: Map<string, string>;
}

/** Resolve a scope to concrete files WITHOUT the prompt-safety cap — a rollback
 *  must see every file, or a large repo would snapshot/tombstone incompletely. */
function resolveAll(cwd: string, scope: readonly string[]): Promise<string[]> {
  return resolveScopeFiles(cwd, scope, Number.POSITIVE_INFINITY);
}

/**
 * Capture a rollback point for `scope` (which may contain globs — e.g. the
 * whole-repo `**\/*`). Records pre-existing contents AND the pre-existing path
 * set so a later `restoreFiles` can both rewrite edits and remove files the
 * attempt created. The shared substrate for quality- and review-repair, so the
 * revert semantics can't drift between them.
 */
export async function snapshotFiles(
  cwd: string,
  scope: readonly string[]
): Promise<IFileSnapshot> {
  const existed = new Set<string>();
  const contents = new Map<string, string>();

  for (const file of await resolveAll(cwd, scope)) {
    const handle = Bun.file(join(cwd, file));

    if (!(await handle.exists())) {
      continue;
    }

    existed.add(file);

    if (handle.size <= MAX_SNAPSHOT_BYTES) {
      contents.set(file, await handle.text());
    }
  }

  return { cwd, scope, existed, contents };
}

/**
 * Roll the workspace back to a snapshot: rewrite every captured file, then delete
 * any file now present in scope that did NOT exist at snapshot time (a tombstone
 * for a helper/test the failed attempt created). Without the tombstone pass a
 * reverted repair would leave new files behind.
 */
export async function restoreFiles(snapshot: IFileSnapshot): Promise<void> {
  const { cwd, scope, existed, contents } = snapshot;

  for (const [file, content] of contents) {
    await Bun.write(join(cwd, file), content);
  }

  for (const file of await resolveAll(cwd, scope)) {
    if (!existed.has(file)) {
      await rm(join(cwd, file), { force: true });
    }
  }
}
