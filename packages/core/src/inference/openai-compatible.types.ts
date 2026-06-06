export interface IOpenAICompatibleConfig {
  /** Root of the OpenAI-compatible API, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  /** Model id, e.g. qwen3.6-27b */
  model: string;
  apiKey?: string;
  /**
   * Abort a single request after this many ms (default LIMITS.requestTimeoutMs).
   * Generous because local generations are slow, but bounded so a hung server
   * can't wedge an unattended run forever.
   */
  timeoutMs?: number;
  /**
   * Hard cap on tokens per response (default LIMITS.maxTokens). Bounds a
   * degenerate repetition loop so one runaway generation can't spew until the
   * context limit. Generous enough for whole-file tool-call output.
   */
  maxTokens?: number;
  /**
   * vLLM repetition penalty (>1 discourages repeating tokens). The cure for the
   * degenerate loops this local model falls into at temp 0 — where it repeats
   * the same line/JSON until max_tokens. ~1.1 breaks loops without hurting
   * correctness. Omitted (1.0 = off) by default; set it on code-gen providers.
   */
  repetitionPenalty?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}
