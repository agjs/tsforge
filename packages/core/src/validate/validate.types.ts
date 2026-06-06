/** One failure from the gate, with a stable key so we can diff across cycles. */
export interface IErrorItem {
  key: string;
  file?: string;
  line?: number;
  rule?: string;
  message: string;
}

export type ErrorSet = IErrorItem[];

export interface IErrorDiff {
  fixed: ErrorSet;
  introduced: ErrorSet;
  remaining: ErrorSet;
}

/** Parse raw gate output (tsc/eslint/test) into a structured error set. */
export type ErrorParser = (output: string) => IErrorItem[];

/** Alias kept for the parser-registry call sites. */
export type ErrorParserFn = ErrorParser;

export interface IValidateResult {
  passed: boolean;
  errors: ErrorSet;
  output: string;
}

export interface IRunTestsResult {
  /** Tests that passed. */
  pass: number;
  /** Tests that failed. */
  fail: number;
  /** Total tests the runner collected. 0 means empty/unparseable/vacuous. */
  total: number;
  /**
   * Load/parse errors (missing import, syntax error). bun reports these as a
   * failing "test", so `errors > 0` tells "ran and some assertions failed"
   * (RED) from "the file never loaded".
   */
  errors: number;
  /** Combined stdout + stderr, for feeding a failure back to the model. */
  output: string;
}

export interface IAcceptResult {
  /** True when the command exits 0. */
  passed: boolean;
  /** Combined stdout + stderr, for feeding back into the loop. */
  output: string;
}
