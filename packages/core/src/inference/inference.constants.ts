/**
 * Provider tuning. Defaults for the OpenAI-compatible client — kept with the
 * inference domain (not a global bucket) so the provider's knobs live next to it.
 */
export const PROVIDER_LIMITS = {
  /**
   * Default model output token budget. Single source of truth (previously split
   * between the CLI and the provider, which silently truncated large generations).
   */
  maxTokens: 16384,
  /** Per-request timeout (ms): generous for slow local generations, bounded so a
   *  hung server can't wedge an unattended run forever. */
  requestTimeoutMs: 600_000,
  /** Linear backoff base per retry attempt (ms): attempt N waits N * this. */
  retryBackoffMs: 400,
  /**
   * Recommended vLLM repetition penalty IF you opt in via
   * TSFORGE_REPETITION_PENALTY. OFF by default: applied globally it also
   * penalizes the repetitive tool-call JSON tokens and pushes the model to
   * narrate instead of emit tool calls (→ no files written). Degenerate
   * repetition LOOPS are handled by the StreamGuard (inference/stream-guard.ts)
   * instead, which only watches prose and can't affect tool-calling.
   */
  repetitionPenalty: 1.1,
} as const;

/**
 * Default endpoint + model for the local provider — the single source of truth.
 * Override per-run with TSFORGE_BASE_URL / TSFORGE_MODEL.
 */
export const PROVIDER_DEFAULTS = {
  baseUrl: "http://192.168.20.107:8000/v1",
  model: "qwen3.6-35b-a3b",
} as const;
