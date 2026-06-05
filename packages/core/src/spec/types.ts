/** One chunk of work, derived from the spec's task breakdown. */
export interface ITask {
  /** Stable id (the task number in v1). */
  id: string;
  /** The per-chunk proof: a shell command that must pass to close the chunk. */
  accept: string;
  /** Editable scope globs. Edits/creates outside these are rejected (drift tripwire). */
  files: string[];
  /** Read-only files shown to the model for context but never edited (e.g. tests). */
  context?: string[];
  /**
   * The spec's intent/contract (its `## Acceptance criteria` prose) shown to the
   * implement agent so it works from the stated goal instead of reverse-engineering
   * it from positional test calls — where one ambiguous case can mislead it.
   */
  intent?: string;
  /** Optional auto-fix command run after each edit, before re-validating (e.g. `eslint --fix`). */
  fix?: string;
}

/** A parsed spec: intent up top, decomposition in tasks. */
export interface ISpec {
  id: string;
  title: string;
  /** The whole-spec gate, run once all tasks are green. */
  verify: string;
  tasks: ITask[];
}
