import { join } from "node:path";
import { rm } from "node:fs/promises";
import { resolveScopeFilesForRollback, isBinaryPath } from "../lib/fs";

/** Per-file size cap for STRING content backing (matches readFiles' MAX_FILE_BYTES): a
 *  source file we'd ever edit is well under this. A text file over this — or any binary —
 *  is backed by RAW BYTES instead (up to MAX_RAW_SNAPSHOT_BYTES). */
const MAX_SNAPSHOT_BYTES = 131_072;

/** Hard ceiling on RAW-BYTE backing. Lockfiles (bun.lockb, a multi-MB package-lock.json)
 *  are the real target and sit well under this; the cap stops a broad `**\/*` scope from
 *  buffering a huge artifact (video/wasm/archive) fully into memory — with WS-B default-ON
 *  a rollback could otherwise OOM. A file over BOTH caps degrades to existence-only:
 *  tracked so it isn't tombstoned, but not restored (best-effort, not airtight). */
const MAX_RAW_SNAPSHOT_BYTES = 8_388_608; // 8 MiB

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
  /** Pre-edit contents of the TEXT files small enough to back as strings (keyed by rel path). */
  contents: Map<string, string>;
  /** Pre-edit RAW bytes of the files a string can't faithfully hold: binaries (e.g.
   *  `bun.lockb`) and oversize text (a large `package-lock.json` over MAX_SNAPSHOT_BYTES).
   *  Without this a dependency spray that rewrites a lockfile would report "reverted" while
   *  the sprayed lockfile stayed on disk — restore must rewrite these byte-for-byte too. */
  raw: Map<string, Uint8Array>;
}

/**
 * Capture a rollback point for `scope` (which may contain globs — e.g. the
 * whole-repo `**\/*`). One traversal: every existing file is recorded in `existed`
 * for tombstoning; text files under MAX_SNAPSHOT_BYTES are string-backed, and
 * binaries / oversize text up to MAX_RAW_SNAPSHOT_BYTES are RAW-BYTE backed (so a
 * lockfile restores faithfully). A file over BOTH caps is existence-only. The shared
 * substrate for quality- and review-repair, so revert semantics can't drift between them.
 */
export async function snapshotFiles(
  cwd: string,
  scope: readonly string[]
): Promise<IFileSnapshot> {
  const existed = new Set<string>();
  const contents = new Map<string, string>();
  const raw = new Map<string, Uint8Array>();

  for (const file of await resolveScopeFilesForRollback(cwd, scope)) {
    const handle = Bun.file(join(cwd, file));

    if (!(await handle.exists())) {
      continue;
    }

    existed.add(file);

    if (!isBinaryPath(file) && handle.size <= MAX_SNAPSHOT_BYTES) {
      contents.set(file, await handle.text());
    } else if (handle.size <= MAX_RAW_SNAPSHOT_BYTES) {
      // Binary (lockfiles like bun.lockb) or oversize text (a big package-lock.json): back it
      // by RAW BYTES so restore is faithful. A string round-trip would corrupt the binary and
      // the string cap would silently drop the oversize file, leaving a spray un-reverted.
      // Over MAX_RAW_SNAPSHOT_BYTES the file is left existence-only (see the cap's rationale) —
      // it won't OOM the rollback, and it's still tracked so it isn't wrongly tombstoned.
      raw.set(file, new Uint8Array(await handle.arrayBuffer()));
    }
  }

  return { cwd, scope, existed, contents, raw };
}

/**
 * Roll the workspace back to a snapshot: rewrite every captured file, then delete
 * any file now present in scope that did NOT exist at snapshot time (a tombstone
 * for a helper/test/asset the failed attempt created). The tombstone scan is
 * binary-inclusive and uncapped, or a created asset would report "reverted" while
 * surviving on disk.
 */
export async function restoreFiles(snapshot: IFileSnapshot): Promise<void> {
  const { cwd, scope, existed, contents, raw } = snapshot;

  for (const [file, content] of contents) {
    await Bun.write(join(cwd, file), content);
  }

  // Rewrite the byte-backed files (binaries + oversize text) faithfully.
  for (const [file, bytes] of raw) {
    await Bun.write(join(cwd, file), bytes);
  }

  for (const file of await resolveScopeFilesForRollback(cwd, scope)) {
    if (!existed.has(file)) {
      await rm(join(cwd, file), { force: true });
    }
  }
}
