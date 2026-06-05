/** A single targeted edit: replace an exact, unique snippet. */
export interface IEdit {
  file: string;
  oldString: string;
  newString: string;
}

export type EditResult =
  | { ok: true; file: string }
  | {
      ok: false;
      file: string;
      reason: "missing-file" | "not-found" | "ambiguous";
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
      reason: "missing-file" | "not-found" | "ambiguous";
      matches?: number;
    };

/** Create a brand-new file. */
export interface ICreateFile {
  file: string;
  content: string;
}

export type CreateResult =
  | { ok: true; file: string }
  | { ok: false; file: string; reason: "exists" };
