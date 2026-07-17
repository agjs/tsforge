export interface IFailureParserState {
  app: string;
  currentFile: string;
  inLintMeta: boolean;
  inUnusedFiles: boolean;
  /** The vitest test file named by the most recent `FAIL <file>` line, awaiting its error
   *  detail on following lines. Empty when not inside a vitest failure block. Lets a UI
   *  test failure become an actionable `failure:<file>::vitest:<detail>` signature instead
   *  of an opaque gate-nonzero. MUST be flushed/reset at an app boundary so a pending file
   *  never grabs the next app's error line (cross-app contamination). */
  pendingVitestFile: string;
  /** The failing test title from a `FAIL <file> > <describe> > <test>` line (parameter
   *  suffixes like `[mobile]` kept), or "" for a bare suite-load FAIL. */
  pendingVitestName: string;
  /** The captured error line for the pending vitest failure — a `Caused by:` root cause
   *  wins over the first generic `*Error:`/`Expected` line. Stored verbatim (no
   *  truncation); composed with the test name at flush. */
  pendingVitestError: string;
}
