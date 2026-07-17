export interface IFailureParserState {
  app: string;
  currentFile: string;
  inLintMeta: boolean;
  inUnusedFiles: boolean;
  /** Inside a `::tsforge-eslint-json <app>::` … `::tsforge-eslint-json-end::` block —
   *  its lines are raw JSON (parsed separately) and must be skipped by the line loop
   *  so a message string like `error TS…` can't be mistaken for a tsc diagnostic. */
  inEslintJson: boolean;
  /** The apps whose eslint-JSON block PARSED into a valid eslint-result array — for
   *  those apps eslint failures come from the STRUCTURED JSON, so the line loop
   *  ignores their stylish eslint rows. PER-APP (not global): an app whose block is
   *  absent/malformed/wrong-shaped still falls back to scraping stylish, so a lint
   *  error is never silently lost (no false green). */
  eslintJsonApps: Set<string>;
}
