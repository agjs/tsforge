/** Terminal status of a single task run — compare against these, not bare strings. */
export const RUN_STATUS = {
  done: "done",
  stuck: "stuck",
  redNotConfirmed: "red-not-confirmed",
} as const;

/** Why a run gave up (only set when status is `stuck`). */
export const STUCK_REASON = {
  stalled: "stalled",
  cap: "cap",
} as const;

/** Whole-spec outcome — compare against these, never the bare string. */
export const SPEC_STATUS = {
  done: "done",
  blocked: "blocked",
} as const;

/**
 * Loop tuning — kept with the loop domain (not a global bucket). Each value's
 * rationale lives here so a tuning pass sees the whole budget at a glance.
 */
export const LOOP_LIMITS = {
  /** Max chars of a tool's output fed back to the model (keeps context bounded). */
  maxToolOutputChars: 4000,
  /**
   * Reject an edit replacement spanning more than this many lines — a push
   * toward surgical changes over lazy whole-file rewrites. 50 admits real
   * functions, still rejects ~80-line rewrites; the gate re-validates anyway.
   */
  maxEditLines: 50,
  /**
   * Give up after the gate shows the EXACT same error set this many edits in a
   * row (genuine spinning). Generous; the turn cap is the real backstop.
   */
  gateStuckRepeats: 10,
  /**
   * Above this many chars of combined file content, the seed prompt sends a
   * navigable project MAP instead of full dumps. Below it, full dumps.
   */
  mapThresholdChars: 12000,
  /** Hard backstop on model turns per task. */
  maxTurns: 40,
} as const;
