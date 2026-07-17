export interface IFailureParserState {
  app: string;
  currentFile: string;
  inLintMeta: boolean;
  inUnusedFiles: boolean;
  /** Inside a `::tsforge-eslint-json::` … `::tsforge-eslint-json-end::` block — its
   *  lines are raw JSON (parsed separately) and must be skipped by the line loop so a
   *  message string like `error TS…` can't be mistaken for a tsc diagnostic. */
  inEslintJson: boolean;
  /** A parseable eslint-JSON block was present in this run, so eslint failures come
   *  from the STRUCTURED JSON — the line loop then ignores the ambiguous "stylish"
   *  eslint rows. Absent ⇒ fall back to scraping stylish (never a false green). */
  eslintJsonPresent: boolean;
}
