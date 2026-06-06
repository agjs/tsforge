/** A single targeted edit: replace an exact, unique snippet. */
export interface IEdit {
  file: string;
  oldString: string;
  newString: string;
}

/** Why an edit failed to apply (compare against these, never the bare string). */
export const EDIT_FAIL_REASON = {
  missingFile: "missing-file",
  notFound: "not-found",
  ambiguous: "ambiguous",
} as const;

export type EditFailReason =
  (typeof EDIT_FAIL_REASON)[keyof typeof EDIT_FAIL_REASON];

export type EditResult =
  | { ok: true; file: string }
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
  | { ok: true; file: string; count: number }
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

/** Why a create failed (compare against this, never the bare string). */
export const CREATE_FAIL_REASON = {
  exists: "exists",
} as const;

export type CreateFailReason =
  (typeof CREATE_FAIL_REASON)[keyof typeof CREATE_FAIL_REASON];

export type CreateResult =
  | { ok: true; file: string }
  | { ok: false; file: string; reason: CreateFailReason };
