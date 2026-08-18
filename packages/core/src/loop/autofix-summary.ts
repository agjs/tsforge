/**
 * Content-based auto-fix detection + per-file summaries. The old notice named
 * files by mtime alone, so it (a) reported touched-but-identical files as
 * "auto-fixed" and (b) told the model nothing about WHAT changed — it re-read
 * whole files to find out (self-eval wish seed-2). Snapshotting content around
 * the janitor pass costs one text() per in-scope file per settle (≤128KB each,
 * binaries skipped) — cheap next to the gate's tsc run — and buys exact change
 * detection plus a changed-line count per file.
 */
import { join } from "node:path";
import { resolveScopeFiles, isBinaryPath } from "../lib/fs";
import { trace } from "../lib/trace";
import { MAX_SNAPSHOT_BYTES } from "./file-snapshot";

/** Per-file counts from the deterministic fixers (ints the fixers already
 *  return); formatting has no counter — a changed file with none of these is
 *  labeled `formatting` (or `formatting/fix` when a fix command also ran). */
export interface IFixCounts {
  tsQuickFixes: number;
  importsOrganized: number;
  idiomRewrites: number;
}

export interface IFixFileState {
  mtime: number;
  /** Absent for binaries and oversize files — those can't be content-compared,
   *  so an mtime advance alone keeps them in the changed set (lines unknown). */
  text?: string;
}

/** One result of the auto-fix pass: which files REALLY changed (content-verified
 *  where possible) and a per-file annotated one-liner for the model notice. */
export interface IAutoFixSummary {
  files: string[];
  /** Same order as `files`: "src/a.ts (formatting, 4 lines)". */
  summary: string[];
}

/** Snapshot mtime + content (when comparable) of the editable scope. */
export async function snapshotFixState(
  cwd: string,
  files: readonly string[]
): Promise<Map<string, IFixFileState>> {
  const out = new Map<string, IFixFileState>();

  for (const f of await resolveScopeFiles(cwd, [...files])) {
    try {
      const handle = Bun.file(join(cwd, f));
      const state: IFixFileState = { mtime: handle.lastModified };

      if (!isBinaryPath(f) && handle.size <= MAX_SNAPSHOT_BYTES) {
        state.text = await handle.text();
      }

      out.set(f, state);
    } catch (err) {
      // ignore — a file that can't be stat'd/read just isn't tracked
      trace("snapshotFixState", err);
    }
  }

  return out;
}

/** Cap mirrors renderDiff's MAX_DIFF_CELLS: past it the LCS matrix would be the
 *  cost, so degrade to "everything changed" rather than allocate it. */
const MAX_LCS_CELLS = 250_000;

/**
 * Changed lines between two texts: removed + added, via LCS length (the same
 * measure renderDiff draws). Oversize inputs degrade to old+new totals.
 */
export function countChangedLines(before: string, after: string): number {
  const a = before.split("\n");
  const b = after.split("\n");

  if (a.length * b.length > MAX_LCS_CELLS) {
    return a.length + b.length;
  }

  // LCS length only (no ops needed) — one rolling row keeps it O(min) memory.
  let prev = new Array<number>(b.length + 1).fill(0);
  let row = new Array<number>(b.length + 1).fill(0);

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] =
        a[i] === b[j]
          ? (prev[j + 1] ?? 0) + 1
          : Math.max(prev[j] ?? 0, row[j + 1] ?? 0);
    }

    [prev, row] = [row, prev];
  }

  const lcs = prev[0] ?? 0;

  return a.length - lcs + (b.length - lcs);
}

function plural(count: number, singular: string, pluralWord: string): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

function annotate(
  counts: IFixCounts | undefined,
  hasFixCommand: boolean,
  lines: number | undefined
): string {
  const parts: string[] = [];

  if (counts !== undefined && counts.tsQuickFixes > 0) {
    parts.push(plural(counts.tsQuickFixes, "TS quick-fix", "TS quick-fixes"));
  }

  if (counts !== undefined && counts.importsOrganized > 0) {
    parts.push("imports organized");
  }

  if (counts !== undefined && counts.idiomRewrites > 0) {
    parts.push(plural(counts.idiomRewrites, "idiom rewrite", "idiom rewrites"));
  }

  // No fixer claimed the change → the format janitor (or the fix command) did.
  if (parts.length === 0) {
    parts.push(hasFixCommand ? "formatting/fix" : "formatting");
  }

  if (lines !== undefined) {
    parts.push(`${lines} lines`);
  }

  return parts.join(", ");
}

/**
 * Diff the two snapshots into the REAL changed set with annotations. A file
 * whose mtime advanced but whose content is byte-identical is dropped — the
 * mtime-only detector reported those as "auto-fixed" and sent the model
 * re-reading files that never changed.
 */
export function buildAutoFixSummary(
  before: Map<string, IFixFileState>,
  after: Map<string, IFixFileState>,
  counts: ReadonlyMap<string, IFixCounts>,
  hasFixCommand: boolean
): IAutoFixSummary {
  const files: string[] = [];
  const summary: string[] = [];

  for (const [f, curr] of after) {
    const prev = before.get(f);

    if (prev !== undefined && curr.mtime <= prev.mtime) {
      continue;
    }

    let lines: number | undefined;

    if (prev?.text !== undefined && curr.text !== undefined) {
      if (prev.text === curr.text) {
        continue;
      }

      lines = countChangedLines(prev.text, curr.text);
    }

    files.push(f);
    summary.push(`${f} (${annotate(counts.get(f), hasFixCommand, lines)})`);
  }

  return { files, summary };
}
