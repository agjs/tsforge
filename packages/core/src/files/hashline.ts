/**
 * Hashline edit system: per-session snapshot store, parser, and 3-way merge recovery.
 * Binds hashline section tags to the file content that minted them; allows edits
 * against stale tags via snapshot-based recovery (3-way merge: snapshot=base,
 * live=theirs, edited-snapshot=ours).
 */

import { join } from "node:path";
import {
  computeFileHash,
  parseHashHeader,
  normalizeHash,
  HL_HEADER_SIGIL,
} from "./hashline-format";

/**
 * One full-file version observed at a point in time.
 */
export interface ISnapshot {
  readonly path: string;
  readonly text: string;
  readonly hash: string;
  recordedAt: number;
}

/**
 * Per-path LRU history: keep up to 4 snapshots per file.
 */
export interface ISnapshotHistory {
  path: string;
  versions: ISnapshot[];
}

/**
 * In-memory snapshot store: per-path LRU with up to 4 versions per path.
 * Thread-safe for in-session use; session is single-threaded so no locks needed.
 */
export class SessionSnapshotStore {
  readonly #histories = new Map<string, ISnapshotHistory>();

  readonly #pathLru: string[] = []; // LRU path ordering

  readonly maxVersionsPerPath = 4;

  readonly maxPaths = 30;

  /**
   * Record a file snapshot. Returns the computed hash.
   * If the same content is recorded again, promotes it to head and reuses the tag.
   */
  record(filePath: string, fullText: string): string {
    const hash = computeFileHash(fullText);

    let history = this.#histories.get(filePath);

    if (!history) {
      history = { path: filePath, versions: [] };
      this.#histories.set(filePath, history);
      this.#pathLru.push(filePath);
    } else {
      // Promote to LRU head
      const idx = this.#pathLru.indexOf(filePath);

      if (idx !== -1) {
        this.#pathLru.splice(idx, 1);
      }

      this.#pathLru.push(filePath);
    }

    // Check if we already have this exact content
    const existing = history.versions.find((v) => v.hash === hash);

    if (existing) {
      existing.recordedAt = Date.now();
      // Move to head
      const idx = history.versions.indexOf(existing);

      if (idx > 0) {
        history.versions.splice(idx, 1);
        history.versions.unshift(existing);
      }

      return hash;
    }

    // Record new version at head
    const snapshot: ISnapshot = {
      path: filePath,
      text: fullText,
      hash,
      recordedAt: Date.now(),
    };

    history.versions.unshift(snapshot);

    // Keep only latest maxVersionsPerPath
    if (history.versions.length > this.maxVersionsPerPath) {
      history.versions.pop();
    }

    // Evict LRU paths if we exceed maxPaths
    while (this.#pathLru.length > this.maxPaths) {
      const lruPath = this.#pathLru.shift();

      if (lruPath !== undefined) {
        this.#histories.delete(lruPath);
      }
    }

    return hash;
  }

  /**
   * Get the most recent snapshot for a path, or null.
   */
  head(filePath: string): ISnapshot | null {
    return this.#histories.get(filePath)?.versions[0] ?? null;
  }

  /**
   * Get a specific historical snapshot by path and hash, or null.
   */
  byHash(filePath: string, hash: string): ISnapshot | null {
    const history = this.#histories.get(filePath);

    if (!history) {
      return null;
    }

    return history.versions.find((v) => v.hash === normalizeHash(hash)) ?? null;
  }

  /**
   * Clear all snapshots.
   */
  clear(): void {
    this.#histories.clear();
    this.#pathLru.length = 0;
  }
}

/**
 * Parsed hashline edit operation.
 */
export interface IEditOp {
  kind: "replace" | "delete" | "insert";
  startLine?: number;
  endLine?: number;
  insertPos?: "before" | "after";
  insertAnchor?: number;
  lines: string[]; // payload lines
  lineNum: number; // source line in the edit text (for error reporting)
}

/**
 * Result of applying a hashline edit.
 */
export interface IHashlineResult {
  ok: boolean;
  file: string;
  newHash?: string;
  /** On a successful edit: false when the ops resolved to identical content (a
   *  no-op write). The caller must NOT count a no-op as a mutation or re-gate. */
  changed?: boolean;
  reason?: string; // error reason
  suggestions?: string[]; // actionable feedback
  /** On a successful changed edit: the file content BEFORE the edit and the new
   *  content written — so a caller can validate the result (e.g. a syntax-
   *  regression guard) and revert by re-writing `previousContent` if needed. */
  previousContent?: string;
  newContent?: string;
}

const HL_PAYLOAD_PREFIX = "+";

/**
 * Parse the header line (¶path#HASH). Returns {path, hash} or null.
 */
function parseHeaderLine(
  headerLine: string,
  errors: string[]
): { filePath: string; fileHash: string | undefined } {
  const header = parseHashHeader(headerLine);

  if (header) {
    return { filePath: header.path, fileHash: header.hash };
  }

  if (headerLine.trim() !== "") {
    errors.push(
      `Expected header ¶path#HASH on first line, got: ${JSON.stringify(
        headerLine.slice(0, 80)
      )}`
    );
  }

  return { filePath: "", fileHash: undefined };
}

/**
 * Parse operation lines and collect ops.
 */
function parseOperations(
  lines: string[],
  startIdx: number,
  errors: string[]
): IEditOp[] {
  const ops: IEditOp[] = [];
  let currentOp: IEditOp | null = null;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trimEnd();

    if (trimmed === "") {
      continue;
    }

    // Check if this is a payload line (starts with +)
    if (trimmed.startsWith(HL_PAYLOAD_PREFIX)) {
      if (currentOp) {
        currentOp.lines.push(trimmed.slice(1)); // Strip the + prefix
      } else {
        errors.push(
          `Payload line without operation: ${JSON.stringify(
            trimmed.slice(0, 60)
          )}`
        );
      }

      continue;
    }

    // Try to parse as an operation header
    const op = parseOpHeader(trimmed, i + 1);

    if (op) {
      if (currentOp) {
        ops.push(currentOp);
      }

      currentOp = op;
    } else if (trimmed.length > 0) {
      errors.push(`Unrecognized line: ${JSON.stringify(trimmed.slice(0, 60))}`);
    }
  }

  if (currentOp) {
    ops.push(currentOp);
  }

  return ops;
}

/**
 * Parse a single operation header line. Returns null if not recognized.
 */
function parseOpHeader(line: string, lineNum: number): IEditOp | null {
  // replace N..M: or replace N..M
  let match = /^replace\s+(\d+)(?:\.\.(\d+))?\s*:?/i.exec(line);

  if (match) {
    const startLine = parseInt(match[1] ?? "0", 10);
    const endLine = match[2] !== undefined ? parseInt(match[2], 10) : startLine;

    return {
      kind: "replace",
      startLine,
      endLine,
      lines: [],
      lineNum,
    };
  }

  // delete N..M or delete N
  match = /^delete\s+(\d+)(?:\.\.(\d+))?/i.exec(line);

  if (match) {
    const startLine = parseInt(match[1] ?? "0", 10);
    const endLine = match[2] !== undefined ? parseInt(match[2], 10) : startLine;

    return {
      kind: "delete",
      startLine,
      endLine,
      lines: [],
      lineNum,
    };
  }

  // insert before N: or insert after N:
  match = /^insert\s+(before|after)\s+(\d+)\s*:?/i.exec(line);

  if (match) {
    const posText = (match[1] ?? "").toLowerCase();
    const insertPos = posText === "before" ? "before" : "after";
    const insertAnchor = parseInt(match[2] ?? "0", 10);

    return {
      kind: "insert",
      insertPos,
      insertAnchor,
      lines: [],
      lineNum,
    };
  }

  return null;
}

/**
 * Parse a hashline edit input. Lenient: accepts `replace N..M:` or `replace N..M` or
 * `delete N..M`, `insert before N:` or `insert after N:`, with optional body lines
 * prefixed `+`. Returns parsed operations and the file header (path, hash).
 */
export function parseHashlineEdit(input: string): {
  filePath: string;
  fileHash: string | undefined;
  ops: IEditOp[];
  errors: string[];
} {
  const lines = input.split("\n");
  const errors: string[] = [];
  let filePath = "";
  let fileHash: string | undefined;

  let i = 0;

  // The `¶path#HASH` header is OPTIONAL. The model frequently sends bare ops
  // (`delete 79..164`) — the path is already in the tool args and the hash
  // comes from the `hash` arg — so only treat the first line as a header when
  // it actually looks like one (a malformed sigil header is still an error).
  const headerLine = lines[0] ?? "";

  if (headerLine.startsWith(HL_HEADER_SIGIL)) {
    const parsed = parseHeaderLine(headerLine, errors);

    if (errors.length > 0) {
      return { filePath: "", fileHash: undefined, ops: [], errors };
    }

    filePath = parsed.filePath;
    fileHash = parsed.fileHash;
    i = 1;
  } else if (headerLine.trim() === "") {
    i = 1;
  }

  // Parse operations
  const ops = parseOperations(lines, i, errors);

  if (ops.length === 0 && errors.length === 0) {
    errors.push(
      "No edit operations found. Provide replace/delete/insert ops (optionally after a ¶path#HASH header)."
    );
  }

  return { filePath, fileHash, ops, errors };
}

/**
 * Apply hashline edits to file content. Handles stale-tag recovery via 3-way merge.
 */
/** Write the resolved text and build the success result — but skip the write when
 *  the ops resolved to identical content (a no-op), flagging `changed:false` so the
 *  caller doesn't count a phantom mutation or trigger a needless re-gate. */
async function commitHashline(
  store: SessionSnapshotStore,
  path: string,
  file: string,
  text: string,
  liveContent: string
): Promise<IHashlineResult> {
  const changed = text !== liveContent;

  // Refuse accidental wipe-to-empty. Models often send `replace 1..N:` with a
  // missing `+` payload (or an empty payload), which splices the whole file to
  // "" and reports success with hash #5D05 — then create/edit deadlock on the
  // empty file (dogfood: src/index.css). Empty→empty is a no-op below;
  // empty→content is the recovery path and must stay allowed.
  if (liveContent.trim().length > 0 && text.trim().length === 0) {
    return {
      ok: false,
      file,
      reason: "wipe-to-empty",
      suggestions: [
        `Would wipe ${file} to empty. Include the full replacement lines ` +
          `(each prefixed with \`+\`) in your replace/insert payload, or use ` +
          `\`edit\` with oldString covering the current content and newString ` +
          `as the full rewrite.`,
      ],
    };
  }

  if (changed) {
    await Bun.write(path, text);
    store.record(file, text);
  }

  return {
    ok: true,
    file,
    newHash: computeFileHash(text),
    changed,
    previousContent: liveContent,
    newContent: text,
  };
}

export async function applyHashlineEdit(
  store: SessionSnapshotStore,
  cwd: string,
  file: string,
  fileHash: string | undefined,
  ops: IEditOp[]
): Promise<IHashlineResult> {
  const path = join(cwd, file);
  const f = Bun.file(path);

  if (!(await f.exists())) {
    return {
      ok: false,
      file,
      reason: "missing-file",
      suggestions: [
        `File ${file} does not exist. Use \`create\` to create it.`,
      ],
    };
  }

  const liveContent = await f.text();
  const liveHash = computeFileHash(liveContent);

  // Case 1: Hash matches live file
  if (
    fileHash !== undefined &&
    fileHash.length > 0 &&
    normalizeHash(fileHash) === liveHash
  ) {
    const result = applyOpsToContent(liveContent, ops, file);

    if (!result.ok || result.text === undefined) {
      return { ...result, file };
    }

    return commitHashline(store, path, file, result.text, liveContent);
  }

  // Case 2: Hash is stale, try recovery via snapshot
  if (fileHash !== undefined) {
    const snapshot = store.byHash(file, fileHash);

    if (snapshot) {
      // Try 3-way merge: snapshot=base, live=theirs, edited-snapshot=ours
      const mergedResult = threeWayMerge(snapshot.text, liveContent, ops, file);

      if (
        mergedResult.ok &&
        mergedResult.cleanMerge &&
        mergedResult.text !== undefined
      ) {
        return commitHashline(
          store,
          path,
          file,
          mergedResult.text,
          liveContent
        );
      }

      if (!mergedResult.ok || !mergedResult.cleanMerge) {
        return {
          ok: false,
          file,
          reason: "stale-anchor-conflict",
          suggestions: [
            `The file changed since you read it (was #${fileHash}, now #${liveHash}). ` +
              `Your edits conflict with those changes. Please re-read the file and adjust your edits.`,
          ],
        };
      }
    }

    return {
      ok: false,
      file,
      reason: "stale-anchor",
      suggestions: [
        `The file changed since you read it (was #${fileHash}, now #${liveHash}). ` +
          `Re-read the file to get a current hash, then edit again.`,
      ],
    };
  }

  // Case 3: No hash provided but file exists
  return {
    ok: false,
    file,
    reason: "no-anchor",
    suggestions: [
      `Edit needs a hashline anchor (¶${file}#HASH). Read the file first to get its current hash.`,
    ],
  };
}

/**
 * Apply operations to content directly (hash already validated or not using hash).
 * Operations are applied bottom-up so line numbers stay valid.
 */
function applyOpsToContent(
  content: string,
  ops: IEditOp[],
  _filePath: string
): { ok: boolean; text?: string; reason?: string; suggestions?: string[] } {
  const lines = content.split("\n");

  // Sort ops by line number descending (bottom-up) to preserve line numbers
  const sortedOps = [...ops].sort((a, b) => {
    const aLine = a.startLine ?? a.insertAnchor ?? 0;
    const bLine = b.startLine ?? b.insertAnchor ?? 0;

    return bLine - aLine;
  });

  for (const op of sortedOps) {
    const result = applyOp(lines, op, _filePath);

    if (!result.ok) {
      return result;
    }
  }

  return { ok: true, text: lines.join("\n") };
}

/**
 * Apply a single operation to the lines array (mutates it).
 */
function applyOp(
  lines: string[],
  op: IEditOp,
  _filePath: string
): { ok: boolean; reason?: string; suggestions?: string[] } {
  if (
    op.kind === "replace" &&
    op.startLine !== undefined &&
    op.endLine !== undefined
  ) {
    // 1-indexed, inclusive range
    const start = op.startLine - 1;
    const end = op.endLine; // slice uses exclusive end

    if (start < 0 || end > lines.length || start > end) {
      return {
        ok: false,
        reason: "out-of-bounds",
        suggestions: [
          `replace ${op.startLine}..${op.endLine} is invalid for a ${lines.length}-line file. ` +
            `Check your line numbers and try again.`,
        ],
      };
    }

    lines.splice(start, end - start, ...op.lines);

    return { ok: true };
  }

  if (
    op.kind === "delete" &&
    op.startLine !== undefined &&
    op.endLine !== undefined
  ) {
    const start = op.startLine - 1;
    const end = op.endLine;

    if (start < 0 || end > lines.length || start > end) {
      return {
        ok: false,
        reason: "out-of-bounds",
        suggestions: [
          `delete ${op.startLine}..${op.endLine} is invalid for a ${lines.length}-line file.`,
        ],
      };
    }

    lines.splice(start, end - start);

    return { ok: true };
  }

  if (
    op.kind === "insert" &&
    op.insertPos !== undefined &&
    op.insertAnchor !== undefined
  ) {
    const anchorIdx = op.insertAnchor - 1;

    if (anchorIdx < 0 || anchorIdx >= lines.length) {
      return {
        ok: false,
        reason: "out-of-bounds",
        suggestions: [
          `insert ${op.insertPos ?? ""} ${op.insertAnchor ?? 0}: line does not exist ` +
            `in the ${lines.length}-line file. Check your anchor line number.`,
        ],
      };
    }

    const pos = op.insertPos === "before" ? anchorIdx : anchorIdx + 1;

    lines.splice(pos, 0, ...op.lines);

    return { ok: true };
  }

  return {
    ok: false,
    reason: "invalid-operation",
    suggestions: [`invalid operation: ${op.kind}`],
  };
}

/**
 * 3-way merge: snapshot=base, live=theirs, edited-snapshot=ours.
 * Applies the ops against the snapshot and merges the result into live.
 * Returns whether the merge was clean (no conflicts).
 */
function threeWayMerge(
  base: string,
  theirs: string,
  ops: IEditOp[],
  _filePath: string
): { ok: boolean; text?: string; cleanMerge: boolean } {
  const baseLines = base.split("\n");
  const theirLines = theirs.split("\n");
  const located: { op: IEditOp; index: number; length: number }[] = [];

  // Re-anchor each op: take the base lines it targets and find that exact
  // run (uniquely) in the live file. Edits to lines the live file also
  // changed fail re-anchoring and surface as conflicts.
  for (const op of ops) {
    const range = opAnchorRange(op, baseLines.length);

    if (range === null) {
      return { ok: false, cleanMerge: false };
    }

    const anchor = baseLines.slice(range.start - 1, range.end);
    const index = findUniqueRun(theirLines, anchor);

    if (index === null) {
      return { ok: false, cleanMerge: false };
    }

    located.push({ op, index, length: anchor.length });
  }

  // Apply bottom-up in live coordinates; overlapping targets = conflict.
  located.sort((a, b) => b.index - a.index);

  for (let i = 1; i < located.length; i++) {
    const above = located[i - 1];
    const here = located[i];

    if (
      above !== undefined &&
      here !== undefined &&
      here.index + here.length > above.index
    ) {
      return { ok: false, cleanMerge: false };
    }
  }

  for (const { op, index, length } of located) {
    if (op.kind === "replace") {
      theirLines.splice(index, length, ...op.lines);
    } else if (op.kind === "delete") {
      theirLines.splice(index, length);
    } else if (op.insertPos === "before") {
      theirLines.splice(index, 0, ...op.lines);
    } else {
      theirLines.splice(index + length, 0, ...op.lines);
    }
  }

  return { ok: true, text: theirLines.join("\n"), cleanMerge: true };
}

/** The 1-based inclusive base-line range an op is anchored to. */
function opAnchorRange(
  op: IEditOp,
  lineCount: number
): { start: number; end: number } | null {
  if (op.kind === "insert") {
    const anchor = op.insertAnchor ?? 0;

    return anchor >= 1 && anchor <= lineCount
      ? { start: anchor, end: anchor }
      : null;
  }

  const start = op.startLine ?? 0;
  const end = op.endLine ?? 0;

  return start >= 1 && end >= start && end <= lineCount ? { start, end } : null;
}

/** Index of `needle` as a contiguous run in `haystack`, only if unique. */
function findUniqueRun(
  haystack: readonly string[],
  needle: readonly string[]
): number | null {
  if (needle.length === 0) {
    return null;
  }

  let found = -1;

  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let matches = true;

    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      if (found !== -1) {
        return null;
      }

      found = i;
    }
  }

  return found === -1 ? null : found;
}
