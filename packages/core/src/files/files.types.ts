import {
  type EDIT_FAIL_REASON,
  type CREATE_FAIL_REASON,
} from "./files.constants";

/** A single targeted edit: replace an exact, unique snippet. */
export interface IEdit {
  file: string;
  oldString: string;
  newString: string;
}

export type EditFailReason =
  (typeof EDIT_FAIL_REASON)[keyof typeof EDIT_FAIL_REASON];

export type EditResult =
  | {
      ok: true;
      file: string;
      /** False when the match resolved to identical content (a no-op write) — the
       *  caller must NOT count it as a mutation or re-gate on it. */
      changed: boolean;
    }
  | {
      ok: false;
      file: string;
      reason: EditFailReason;
      /** Number of matches when ambiguous. */
      matches?: number;
    };

/** One replacement within a batched, multi-site edit to a single file. */
export interface IReplacement {
  oldString: string;
  newString: string;
}

export type EditsResult =
  | {
      ok: true;
      file: string;
      count: number;
      /** False when the batch resolved to identical content (a no-op write) — the
       *  caller must NOT count it as a mutation or re-gate on it. */
      changed: boolean;
    }
  | {
      ok: false;
      file: string;
      /** Which replacement in the batch failed (0-based). */
      index: number;
      reason: EditFailReason;
      matches?: number;
    };

/** Create a brand-new file. */
export interface ICreateFile {
  file: string;
  content: string;
}

export type CreateFailReason =
  (typeof CREATE_FAIL_REASON)[keyof typeof CREATE_FAIL_REASON];

export type CreateResult =
  | { ok: true; file: string }
  | { ok: false; file: string; reason: CreateFailReason };

/** Hashline edit request: anchored by content hash for stale-anchor recovery. */
export interface IHashlineEdit {
  file: string;
  /** Content hash from the read annotation (¶path#HASH). */
  hash?: string;
  /** Raw edit payload: header + ops. */
  input: string;
}

export type HashlineFailReason =
  | "missing-file"
  | "no-anchor"
  | "stale-anchor"
  | "stale-anchor-conflict"
  | "parse-error"
  | "out-of-bounds"
  | "invalid-op";

export type HashlineResult =
  | {
      ok: true;
      file: string;
      newHash: string;
      /** False when the ops resolved to identical content (a no-op write) — the
       *  caller must NOT count it as a mutation or re-gate on it. */
      changed: boolean;
    }
  | {
      ok: false;
      file: string;
      reason: HashlineFailReason;
      suggestions?: string[];
    };
