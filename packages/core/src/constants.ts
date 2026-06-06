/**
 * Tunable limits — one documented home instead of magic numbers scattered across
 * the loop, tools, and provider. Each value's rationale lives here so a future
 * tuning pass can see the whole budget at a glance.
 */
export const LIMITS = {
  /** Max chars of a tool's output fed back to the model (keeps context bounded). */
  maxToolOutputChars: 4000,

  /**
   * Reject an edit replacement spanning more than this many lines — a
   * deterministic push toward surgical changes over lazy whole-file rewrites.
   * Tuned 25→50 after the `lang` module showed legit ~27-line function edits
   * rejected at 25; 50 admits real functions, still rejects ~80-line rewrites.
   */
  maxEditLines: 50,

  /**
   * Give up after the gate shows the EXACT same error set this many edits in a
   * row (genuine spinning). Generous because a hard error often needs several
   * attempts; the turn cap is the real backstop.
   */
  gateStuckRepeats: 10,

  /**
   * Above this many chars of combined file content, the seed prompt sends a
   * navigable project MAP instead of full file dumps (the context-management
   * substrate). Below it, full dumps — so small targets are unaffected.
   */
  mapThresholdChars: 12000,

  /** Hard backstop on model turns per task. */
  maxTurns: 40,

  /**
   * Default model output token budget. Single source of truth — previously split
   * between the CLI (16384) and the provider (8192), which silently truncated
   * large generations driven from the provider default.
   */
  maxTokens: 16384,

  /** Per-request timeout (ms) for a model completion. */
  requestTimeoutMs: 600_000,

  /** Linear backoff base per retry attempt (ms): attempt N waits N * this. */
  retryBackoffMs: 400,
} as const;
