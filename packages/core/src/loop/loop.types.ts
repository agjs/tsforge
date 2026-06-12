import type { ErrorParser } from "../validate";
import {
  type RUN_STATUS,
  type STUCK_REASON,
  type SPEC_STATUS,
} from "./loop.constants";

/** A progress event emitted as the loop runs, for live observability. */
export interface ILoopEvent {
  kind:
    | "start"
    | "red"
    | "cycle"
    | "token"
    | "message"
    | "fix"
    | "edit"
    | "create"
    | "validated"
    | "done"
    | "stuck"
    | "run"
    | "tool"
    | "timing"
    | "usage";
  task: string;
  message: string;
  cycle?: number;
  cycles?: number;
  /** For `timing` events: how long the turn took, in milliseconds. */
  ms?: number;
  errors?: number;
  passed?: boolean;
  file?: string;
  /** For `create` events: the new file's content (rendered as a code block). */
  content?: string;
  /** For `edit` events: the replaced / replacement snippets (rendered as a diff). */
  oldString?: string;
  newString?: string;
  /** For `run` events: the shell command and its result. */
  command?: string;
  exitCode?: number;
  output?: string;
  /** For `token` events: which stream it came from. The renderer collapses
   *  `reasoning` to a compact "thinking…" indicator (the full text still goes to
   *  the log); `tool` markers and gate output (no channel) print normally. */
  channel?: "reasoning" | "content" | "tool";
  /** For `usage` events: real per-call token accounting (for the --log metrics). */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** For `usage` (and salvage-warning `tool`) events: whether THIS model call
   *  ran with thinking enabled — lets the analyzer correlate malformed-tool-call
   *  rate with the thinking mode (see analyze-malformed). */
  thinking?: boolean;
  /** For the `start` event: run metadata, so a log is self-describing for the
   *  analyzer (which model / how big a context window the metrics are against). */
  model?: string;
  contextWindow?: number;
}

export type Reporter = (event: ILoopEvent) => void;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];
export type StuckReason = (typeof STUCK_REASON)[keyof typeof STUCK_REASON];
export type SpecStatus = (typeof SPEC_STATUS)[keyof typeof SPEC_STATUS];

export interface IRunResult {
  task: string;
  /** The gate failed before we started (a real goalpost). */
  redConfirmed: boolean;
  status: RunStatus;
  /** Model turns used. */
  cycles: number;
  reason?: StuckReason;
  /** Edits/creates applied to editable files (measure edit churn). */
  edits?: number;
  /** Times an edit RAISED the gate error count (regressions). */
  regressions?: number;
}

export interface IRunOptions {
  parse?: ErrorParser;
  onEvent?: Reporter;
  temperature?: number;
  /** Per-request thinking toggle passed to the provider. */
  enableThinking?: boolean;
  /** Cap reasoning tokens per model call (vLLM `thinking_token_budget`). */
  thinkingTokenBudget?: number;
  /** Hard backstop on model turns (default LOOP_LIMITS.maxTurns). */
  maxTurns?: number;
}

export interface ISpecResult {
  status: SpecStatus;
  results: IRunResult[];
}
