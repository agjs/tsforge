import type { Reporter } from "../loop/events";
import { type SPEC_MODE, type FINDING_KIND } from "./spec.constants";

export type SpecMode = (typeof SPEC_MODE)[keyof typeof SPEC_MODE];

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
  /**
   * Run mode. `scratch` (default): the harness DELETES the editable files to
   * start RED, and the model regenerates them from the spec. `existing`: the
   * project already exists and is kept — RED comes from a new failing test /
   * stated goal, and the model edits in place (a feature/bugfix/refactor).
   */
  mode?: SpecMode;
}

export type FindingKind = (typeof FINDING_KIND)[keyof typeof FINDING_KIND];

/** A teacher-review verdict on one generated test. */
export interface ITestFinding {
  /** Name of the test the finding refers to. */
  test: string;
  kind: FindingKind;
  reason: string;
}

export interface IReviewResult {
  findings: ITestFinding[];
  /** Full corrected test file, or "" when no change is needed. */
  correctedSuite: string;
}

export interface IReviewInput {
  goal: string;
  criteria: string;
  /** The generated test file's contents. */
  testCode: string;
  /** Module specifier the suite imports the impl from (e.g. "./money"). */
  moduleSpecifier: string;
}

export interface IReviewFixOptions {
  testFile: string;
  implFile: string;
  goal: string;
  criteria: string;
  onEvent?: Reporter;
}

export interface IReviewFixResult {
  findings: ITestFinding[];
  /** True only when a correction was written AND it stayed real + RED. */
  applied: boolean;
}
