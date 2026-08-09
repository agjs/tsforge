/**
 * One item from a human-written worklist (PLAN.md / TASKS.md / numbered list).
 * Converted to `IFeature` before `runGreenfield` drives it.
 */
export interface IWorklistItem {
  /** Stable kebab-case id (disambiguated on collision). */
  id: string;
  /** The item text (checkbox body or numbered-line prose). */
  text: string;
  /** True when the source checkbox was already `[x]`. */
  done: boolean;
  /** Optional per-item gate command; inherits the session gate when absent. */
  accept?: string;
  /** Optional editable scope for this item. */
  files?: string[];
  /** Optional extra context paths. */
  context?: string[];
  /** Optional fix hint carried into the implement prompt. */
  fix?: string;
}

export interface IParseWorklistOptions {
  /** When true, keep already-checked `[x]` items (default: drop them). */
  includeDone?: boolean;
}
