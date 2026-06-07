export type Role = "system" | "user" | "assistant" | "tool";

export interface IChatMessage {
  role: Role;
  content: string;
  /** Assistant only: the tool calls it emitted (kept in history so the model
   *  sees what it asked for and the results that came back). */
  toolCalls?: IToolCall[];
  /** Tool messages only: the id of the call this message is the result of. */
  toolCallId?: string;
}

/** A parsed tool call from the model (name + decoded JSON arguments). */
export interface IToolCall {
  /** Correlation id so a tool-result message can reference it. */
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface IModelResponse {
  content: string;
  toolCalls: IToolCall[];
  /** How many tool calls were SALVAGED from malformed content (server parser
   *  left them as text). >0 signals the model emitted unparseable tool syntax. */
  salvaged?: number;
  /** Set when the stream was aborted because the model fell into a degenerate
   *  repetition loop (same line/template until max_tokens). The loop driver
   *  stops the turn instead of nudging into another loop. */
  degenerated?: boolean;
}

export interface ICompleteOptions {
  temperature?: number;
  /** OpenAI-style tool schemas to advertise (opaque JSON). */
  tools?: unknown[];
  /**
   * How hard to push the model to call a tool. `required` forces a tool call —
   * which suppresses chat-style "here is my answer" prose the harness discards
   * anyway. Defaults to `auto`. Ignored when no tools are advertised.
   */
  toolChoice?: "auto" | "required" | "none";
  /** Per-request thinking toggle (Qwen `chat_template_kwargs.enable_thinking`).
   *  Omitted = server default. Off for mechanical work, on for hard reasoning. */
  enableThinking?: boolean;
  /** Cap reasoning tokens before the model must answer (vLLM
   *  `thinking_token_budget`). Omitted = unbounded. The lever for turn *time*. */
  thinkingTokenBudget?: number;
  /** When set, the request streams and each token is delivered here as it
   *  arrives, tagged by channel: `reasoning` (the model's thinking) vs `content`
   *  (its actual answer). Lets a UI dim the thinking and format the answer. */
  onToken?: (text: string, channel: TokenChannel) => void;
  /** Caller cancellation — aborting it stops the request (and any stream)
   *  mid-flight. Combined with the per-request timeout. */
  signal?: AbortSignal;
}

/** Which stream a token belongs to: the model's thinking (`reasoning`), its answer
 *  (`content`), or the tool calls it is emitting (`tool` — the file it's writing,
 *  streamed so a long tool-call generation isn't silent dead air). */
export type TokenChannel = "reasoning" | "content" | "tool";

/** The model seam. Implementations talk to a local server (vLLM/Ollama/...). */
export interface IProvider {
  complete(
    messages: IChatMessage[],
    opts?: ICompleteOptions
  ): Promise<IModelResponse>;
}

export interface IOpenAICompatibleConfig {
  /** Root of the OpenAI-compatible API, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  /** Model id, e.g. qwen3.6-35b-a3b */
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
