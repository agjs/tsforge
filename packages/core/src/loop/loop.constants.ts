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
  readonlySpin: "readonly-spin",
  /** Consecutive create/edit L3 / history-meta rejects with no successful write. */
  historyMetaSpin: "history-meta-spin",
  handoff: "handoff",
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
 * Read-only-spin guard thresholds: consecutive tool calls that touch NO editable
 * file before the model is re-steered to produce concrete work, then parked if
 * the re-steering exhausts all recoveries. Shared by interactive (session.ts)
 * and headless (run.ts) drivers. Mirrored in each if sharing requires deep refactors.
 */
/** Consecutive read-only tool turns before soft re-steer; recoveries then park.
 *  Post-resteer, Session/run force write-only tools — text nudge alone is not enough. */
export const READONLY_STREAK_LIMIT = 12;
export const MAX_READONLY_RECOVERIES = 2;

/**
 * Loop tuning — kept with the loop domain (not a global bucket). Each value's
 * rationale lives here so a tuning pass sees the whole budget at a glance.
 */
export const LOOP_LIMITS = {
  /** Max chars of a tool's output fed back to the model (keeps context bounded). */
  maxToolOutputChars: 4000,
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
   * Once STEERING has begun (a stall was detected and the first steer fired),
   * escalate FAST: climb to the next, more directive rung after only this many
   * non-improving gate cycles, instead of waiting another full `noProgressCycles`/
   * `gateStuckRepeats` window. A live run reached only L1 by turn 105 because the
   * coarse windows re-tripped too slowly over sparse forced-gates, so the L2 rule
   * PLAYBOOK — the rung that actually hands the fix recipe — never arrived. Small,
   * so L1→L2→L3→(expert/park) happens in a handful of gates once it's clear the
   * model is stuck, not dozens.
   */
  steerRetrigger: 2,
  /**
   * PLATEAU (oscillation) backstop. The fine guards above reset on every intermittent
   * success AND every error-SET rotation, so a model that OSCILLATES — fixes the stub
   * stage, breaks lint; fixes lint, re-breaks a stub; never reaching green — crawls up
   * the ladder over 150+ turns and the expert handoff at the top is effectively
   * unreachable (observed live: 166 turns, only 3 escalations, expert fired 0×). This
   * counts gate cycles since the last ALL-TIME-LOW error count (genuine convergence
   * resets it; oscillation does not). Once the full ladder has deployed (L3 + context
   * reset already tried) and this many further gate cycles pass with no new low, hand
   * off to the expert NOW instead of waiting for the glacial natural escalation. This
   * changes only WHEN the escape hatch opens — it relaxes no gate rule.
   */
  plateauGates: 4,
  /**
   * Above this many chars of combined file content, the seed prompt sends a
   * navigable project MAP instead of full dumps. Below it, full dumps.
   */
  mapThresholdChars: 12000,
  /** Shared runaway crash-guard for all loop types (headless, interactive, web).
   *  The PRIMARY terminal is ladder-exhaustion (R5 handoff), not a turn count.
   *  This exists only to kill a zero-progress/never-yielding bug; crossing it
   *  logs an anomaly and returns STUCK_REASON.cap with NO handoff. A user-supplied
   *  `maxTurns` in config/recipes/CLI now maps to this value (changed semantics:
   *  was a task cap, now the crash-guard). Set far above any real converging build. */
  runawayBackstopTurns: 1000,
  /** Heartbeat cadence: emit a checkpoint progress event + snapshot every N turns
   *  without terminating. Decoupled from the crash-guard so runs can persist state
   *  on a regular interval. Reuses the old headless maxTurns number (40). */
  checkpointIntervalTurns: 40,
  /** Legacy aliases for compatibility. Both now map to runawayBackstopTurns. */
  maxTurns: 1000,
  interactiveBackstopTurns: 1000,
  webMaxTurns: 1000,
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
