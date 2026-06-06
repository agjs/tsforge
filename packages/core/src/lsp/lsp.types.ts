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
