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
  /**
   * Default reasoning-token cap for SCRATCH (create-from-spec) tasks, where the
   * model over-thinks unbounded (~92s turn-1, occasional 198s spirals) without
   * converging faster. Measured knee on money: 2048 ≈ 73s/4 turns vs 206s/5.7
   * uncapped, Q-neutral; 4096 rambles back up to 133s. NOT applied to existing-
   * code runs — there the cap HURT navigation (react-board hit 12 turns @2048),
   * since understanding a codebase genuinely needs reasoning. Override per-run
   * with TSFORGE_THINKING_BUDGET / opts.thinkingTokenBudget. Harder algorithmic
   * scratch targets may want a higher override.
   */
  scratchThinkingBudget: 2048,
} as const;
