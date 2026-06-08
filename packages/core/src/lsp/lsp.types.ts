import type ts from "typescript";

export interface ITsDiagnostic {
  code: number;
  message: string;
  file: string;
  start: number;
  length: number;
}

export interface ITsFix {
  description: string;
  /** The text edits this fix applies (possibly across files). */
  changes: readonly ts.FileTextChanges[];
}

/** A reference / definition location, with a 1-based line for readable output. */
export interface ITsLocation {
  file: string;
  line: number;
  start: number;
}

/** A workspace symbol hit (from navigate-to). */
export interface ITsSymbol {
  name: string;
  kind: string;
  file: string;
  line: number;
}

/** Reference sites in one file (the lines that depend on a symbol). */
export interface ITsImpactFile {
  file: string;
  lines: number[];
}

/** The blast radius of a symbol: which files/lines reference it. Type-EXACT (from
 *  the TS LanguageService), not a tree-sitter guess — so it can drive a deliberate
 *  cross-file edit instead of discovering breakage at the gate. */
export interface ITsImpact {
  /** Total reference sites (excluding the declaration itself). */
  total: number;
  /** Number of distinct files that reference the symbol. */
  fileCount: number;
  /** Per-file reference lines, most-referenced file first. */
  files: ITsImpactFile[];
}

/** A 360° view of a symbol: its type, where it's defined, and what references it. */
export interface ITsContext {
  /** Quick-info type string (what `typeAt` returns). */
  type: string;
  definition: ITsLocation[];
  references: ITsLocation[];
}
