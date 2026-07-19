import { join } from "node:path";
import { rm } from "node:fs/promises";
import { resolveScopeFilesForRollback, isBinaryPath } from "../lib/fs";

/** Per-file size cap for STRING content backing (matches readFiles' MAX_FILE_BYTES): a
 *  source file we'd ever edit is well under this. A text file over this — or any binary —
 *  is backed by RAW BYTES instead (up to MAX_RAW_SNAPSHOT_BYTES). */
const MAX_SNAPSHOT_BYTES = 131_072;

/** Per-file ceiling on RAW-BYTE backing. Lockfiles (bun.lockb, a multi-MB package-lock.json)
 *  are the real target and sit well under this; the cap stops a broad `**\/*` scope from
 *  buffering a huge artifact (video/wasm/archive) fully into memory — with WS-B default-ON
 *  a rollback could otherwise OOM. A file over the cap degrades to existence-only:
 *  tracked so it isn't tombstoned, but not restored (best-effort, not airtight). */
const MAX_RAW_SNAPSHOT_BYTES = 8_388_608; // 8 MiB

/** AGGREGATE ceiling on ALL backed bytes across the whole snapshot — string CONTENTS and RAW
 *  combined. The per-file caps alone are not enough: a broad `**\/*` scope (which production
 *  boringstack hosts DO use) with many text files each ≤128 KiB, or many binaries each just
 *  under the raw cap, would still buffer them all and OOM. Once backing a file would push the
 *  running total past this, it degrades to existence-only. Bounds worst-case snapshot memory
 *  on the main WS-B path, not just for broad-scope repair callers. */
const MAX_TOTAL_SNAPSHOT_BYTES = 67_108_864; // 64 MiB

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
  /** Files that EXISTED but were too large to back (over the per-file raw cap, or past the
   *  aggregate raw budget). They're tracked in `existed` (so restore won't tombstone them),
   *  but restore CANNOT revert a mutation to them — this set makes that truncation explicit
   *  (not silent) so a caller can tell whether its revert was complete. */
  skipped: Set<string>;
}

/** Optional size caps for `snapshotFiles` — default to the module constants. Injectable so
 *  the budget behavior is unit-testable with tiny values instead of writing 64 MiB to disk. */
export interface ISnapshotCaps {
  maxFileBytes?: number;
  maxRawBytes?: number;
  maxTotalBytes?: number;
}

/**
 * Capture a rollback point for `scope` (which may contain globs — e.g. the
 * whole-repo `**\/*`). One traversal: every existing file is recorded in `existed`
 * for tombstoning; text files under MAX_SNAPSHOT_BYTES are string-backed, and
 * binaries / oversize text up to MAX_RAW_SNAPSHOT_BYTES are RAW-BYTE backed (so a
 * lockfile restores faithfully). A file over its per-file cap OR past the aggregate budget is
 * existence-only. The shared substrate for quality- and review-repair, so revert semantics
 * can't drift between them. Memory bounds (best-effort, not airtight — matching the plan's
 * run-tool-bypass stance): every backed file (string OR raw) counts against ONE aggregate
 * budget (maxTotalBytes), so total snapshot memory is bounded even on the main WS-B path,
 * which DOES snapshot a `**\/*` scope on production boringstack hosts. Files past the budget
 * land in `skipped` and are surfaced by callers, never silently dropped.
 */
export async function snapshotFiles(
  cwd: string,
  scope: readonly string[],
  caps: ISnapshotCaps = {}
): Promise<IFileSnapshot> {
  const maxFile = caps.maxFileBytes ?? MAX_SNAPSHOT_BYTES;
  const maxRaw = caps.maxRawBytes ?? MAX_RAW_SNAPSHOT_BYTES;
  const maxTotal = caps.maxTotalBytes ?? MAX_TOTAL_SNAPSHOT_BYTES;

  const existed = new Set<string>();
  const contents = new Map<string, string>();
  const raw = new Map<string, Uint8Array>();
  const skipped = new Set<string>();
  let total = 0; // bytes backed so far (contents + raw), bounded by maxTotal

  for (const file of await resolveScopeFilesForRollback(cwd, scope)) {
    const handle = Bun.file(join(cwd, file));

    if (!(await handle.exists())) {
      continue;
    }

    existed.add(file);

    const textEligible = !isBinaryPath(file) && handle.size <= maxFile;

    if (textEligible && total + handle.size <= maxTotal) {
      contents.set(file, await handle.text());
      total += handle.size;
    } else if (
      !textEligible &&
      handle.size <= maxRaw &&
      total + handle.size <= maxTotal
    ) {
      // Binary (lockfiles like bun.lockb) or oversize text (a big package-lock.json): back it
      // by RAW BYTES so restore is faithful. A string round-trip would corrupt the binary and
      // the string cap would silently drop the oversize file, leaving a spray un-reverted.
      raw.set(file, new Uint8Array(await handle.arrayBuffer()));
      total += handle.size;
    } else {
      // Over the per-file raw cap OR past the aggregate budget: existence-only (bounds
      // worst-case memory so a broad `**/*` scope can't OOM the rollback). Tracked in `existed`
      // (not tombstoned) AND surfaced in `skipped` so the incomplete-restore is explicit, not
      // silent — restore cannot revert a mutation to these.
      skipped.add(file);
    }
  }

  return { cwd, scope, existed, contents, raw, skipped };
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

/** A human-readable suffix for a caller's "reverted" message when the snapshot could NOT fully
 *  back some files (existence-only, over the size caps) — so no shared-substrate caller (WS-B
 *  rollback, quality-repair, review-repair) claims a byte-complete revert when a mutation to an
 *  oversize file may persist. Empty string when the revert was complete. */
export function skippedRestoreNote(snapshot: IFileSnapshot): string {
  if (snapshot.skipped.size === 0) {
    return "";
  }

  return ` (⚠ ${String(snapshot.skipped.size)} oversize file(s) not byte-reverted: ${[...snapshot.skipped].slice(0, 3).join(", ")})`;
}
