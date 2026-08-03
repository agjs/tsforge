export type Role = "system" | "user" | "assistant" | "tool";

export interface IChatMessage {
  role: Role;
  content: string;
  /** Assistant only: the tool calls it emitted (kept in history so the model
   *  sees what it asked for and the results that came back). */
  toolCalls?: IToolCall[];
  /** Tool messages only: the id of the call this message is the result of. */
  toolCallId?: string;
  /** Assistant only: the model's chain-of-thought. DeepSeek's thinking mode
   *  REQUIRES the prior turn's `reasoning_content` to be replayed, so it's kept
   *  on the message and re-sent (for the deepseek reasoning style). */
  reasoningContent?: string;
}

/** A parsed tool call from the model (name + decoded JSON arguments). */
export interface IToolCall {
  /** Correlation id so a tool-result message can reference it. */
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Real token accounting from the server's `usage` block — the basis for the
 *  status line's context gauge and (soon) auto-compaction triggering. */
export interface ITokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface IModelResponse {
  content: string;
  toolCalls: IToolCall[];
  /** The model's chain-of-thought (`reasoning`/`reasoning_content`), when it
   *  produced any. Stored on the assistant message for providers (DeepSeek) that
   *  require it replayed on the next turn. */
  reasoning?: string;
  /** Server-reported token usage for this call, when available. `promptTokens`
   *  is the full context the model just saw — what auto-compaction will watch. */
  usage?: ITokenUsage;
  /** How many tool calls were SALVAGED from malformed content (server parser
   *  left them as text). >0 signals the model emitted unparseable tool syntax. */
  salvaged?: number;
  /** Set when the stream was aborted because the model fell into a degenerate
   *  repetition loop (same line/template until max_tokens). The loop driver
   *  stops the turn instead of nudging into another loop. */
  degenerated?: boolean;
  /** Set when TTSR aborted the stream due to a rule match. Contains the rule name
   *  and guidance to append to the corrective retry message. */
  ttsrFired?: { ruleName: string; guidance: string };
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
  /** Reasoning effort level (DeepSeek/OpenAI `reasoning_effort`: "low"|"medium"|"high").
   *  Per-call override, applied by R2 (reason-more) rung. Omitted = use config default. */
  reasoningEffort?: "low" | "medium" | "high";
  /** When set, the request streams and each token is delivered here as it
   *  arrives, tagged by channel: `reasoning` (the model's thinking) vs `content`
   *  (its actual answer). Lets a UI dim the thinking and format the answer. */
  onToken?: (text: string, channel: TokenChannel) => void;
  /** Caller cancellation — aborting it stops the request (and any stream)
   *  mid-flight. Combined with the per-request timeout. */
  signal?: AbortSignal;
  /** TTSR watcher for stream-interrupting rules (wired by the loop, not the provider). */
  ttsrManager?: ITtsrWatcher;
}

/** Structural view of the loop's TtsrManager — keeps the inference layer free of
 *  a hard dependency on loop internals while staying fully typed. */
export interface ITtsrWatcher {
  checkDelta(
    text: string,
    context: { source: "content" | "tool-args"; currentFile?: string }
  ): { readonly name: string; readonly guidance: string } | null;
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
   * Budget (ms) to keep retrying transient CONNECTION failures (server down /
   * restarting) before giving up (default LIMITS.connectRetryMs ≈ 2.4s). An
   * unattended run (headless/eval) sets this high (minutes) so a build survives a
   * model-server restart instead of failing and discarding all progress.
   */
  connectRetryMs?: number;
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
  /**
   * How this provider wants reasoning/thinking expressed on the wire:
   *  - `qwen` (default): `chat_template_kwargs.enable_thinking` + `thinking_token_budget` (vLLM).
   *  - `deepseek`: top-level `thinking: { type }` + `reasoning_effort`; `tool_choice`
   *    is suppressed ONLY on the DeepSeek CLOUD host (api.deepseek.com), which 400s
   *    on it — a local/self-hosted DeepSeek still gets it.
   *  - `openai`: `reasoning_effort`; uses `max_completion_tokens` and omits `temperature` (o-series).
   *  - `none`: no reasoning fields.
   */
  reasoning?: ReasoningStyle;
  /** Reasoning effort for `deepseek`/`openai` styles (maps to `reasoning_effort`). */
  reasoningEffort?: "low" | "medium" | "high";
  /**
   * OPTIONAL override for guided-decoding (structured tool-call) support. Normally
   * unset: the harness auto-detects it — every local/self-hosted endpoint sends
   * `tool_choice`, and only DeepSeek's CLOUD thinking API (api.deepseek.com), which
   * 400s on it, is suppressed. Set `true`/`false` only to override a misdetection.
   */
  guidedDecoding?: boolean;
  /** Arbitrary fields merged into the request body LAST (override anything above) —
   *  the escape hatch for any provider-specific param. */
  extraBody?: Record<string, unknown>;
  /** Arbitrary request headers (e.g. Azure `api-key`, Anthropic `x-api-key`).
   *  `${VAR}` in values is interpolated from the environment. */
  extraHeaders?: Record<string, string>;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

/** Provider reasoning-param dialect.
 *  `vllm` is for a self-hosted vLLM serving a reasoning checkpoint: it reads
 *  `chat_template_kwargs.thinking` and IGNORES DeepSeek cloud's `thinking:{type}`,
 *  so the two cannot share a dialect even for the same model family. */
export type ReasoningStyle =
  | "qwen"
  | "deepseek"
  | "vllm"
  | "openai"
  | "none";
