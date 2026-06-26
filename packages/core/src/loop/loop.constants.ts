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

/** Default sampling temperature for main agent turns (Session, runTask, modelAgent).
 *  Auxiliary one-shot calls (compaction, plan summary, judge) stay at 0. */
export const DEFAULT_TEMPERATURE = 0.2;

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
   * Give up after the gate shows the EXACT same error SET this many edits in a
   * row (genuine spinning) — the coarse net. The finer `samePersist` guard
   * (below) usually trips first; this catches a stable-but-shuffling set.
   */
  gateStuckRepeats: 6,
  /**
   * The PRIMARY no-progress guard: give up when a SINGLE error — same (file,rule)
   * key — survives this many consecutive gate cycles, i.e. the model keeps failing
   * at the same thing N attempts running, even while OTHER errors churn around it.
   * This (not a raw turn count) is how the loop decides it's genuinely stuck.
   */
  samePersist: 5,
  /**
   * Net-progress guard: give up when the gate's TOTAL error count hasn't reached a
   * new low in this many consecutive cycles — the model is churning without getting
   * closer to green (errors shuffle, so `gateStuckRepeats` keeps resetting, and no
   * single error survives `samePersist`). This — convergence, not a turn count — is
   * what bounds a run: a big app may take any number of turns, but it must keep
   * REDUCING errors. Generous enough to absorb a feature-add spike (write files →
   * errors rise → fixed below the prior best resets it).
   */
  noProgressCycles: 12,
  /**
   * Above this many chars of combined file content, the seed prompt sends a
   * navigable project MAP instead of full dumps. Below it, full dumps.
   */
  mapThresholdChars: 12000,
  /** Hard backstop on model turns per HEADLESS task (eval/cron — no human to
   *  intervene). Interactive sessions use `interactiveBackstopTurns` instead. */
  maxTurns: 40,
  /** Interactive runaway safety only — NOT the primary stop. A human is present
   *  and can interrupt, and the progress guards (`samePersist` / `gateStuckRepeats`)
   *  pull the agent out the moment it stops converging, so this is set high enough
   *  that normal long, productive back-and-forth never trips it. */
  interactiveBackstopTurns: 250,
  /** Web build RUNAWAY CEILING — NOT a completion budget. No fixed turn count fits
   *  every app (size/complexity vary), so the real stop is the net-progress guard
   *  (`noProgressCycles`) + `samePersist`/`gateStuckRepeats`: a build runs as long as
   *  it keeps REDUCING errors, however many turns that takes. This is only a final
   *  cost/infinite-loop safety for a pathological build that "progresses" forever
   *  without finishing — set far above any real converging build. */
  webMaxTurns: 400,
  /**
   * How many times a build turn may dump file contents as a chat message (instead
   * of calling `create`) before the session gives up. Each time we nudge it to use
   * tools; past this it's clearly not going to act, so stop with a clear message
   * rather than loop forever narrating code.
   */
  maxBuildNudges: 2,
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
