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
} as const;
