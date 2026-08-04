import type { IReasoningProfile, ReasoningStyle } from "./reasoning-profile";

export type {
  IReasoningProfile,
  IWireFlag,
  ReasoningStyle,
} from "./reasoning-profile";

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
  /**
   * Constrain the reply to JSON — `json_object` for "valid JSON", or
   * `json_schema` to pin the SHAPE as well. Runtimes that support it (vLLM,
   * SGLang, OpenAI) enforce this during decoding, so the answer parses by
   * construction rather than by luck.
   *
   * The self-harness proposer needs this: asking DeepSeek for "a JSON patch,
   * no prose" lost 4 of 6 candidates to `unparseable proposer response`, which
   * silently cut the paper's proposal width K from 3 to 1.
   *
   * Endpoints that do not understand the field ignore it, so a caller must
   * still handle a non-JSON reply.
   */
  responseFormat?: IResponseFormat;
}

/** How a reply is constrained. `schema` is an opaque JSON Schema — the shape
 *  belongs to the caller, and the inference layer only forwards it. */
export type IResponseFormat =
  | { readonly type: "json_object" }
  | {
      readonly type: "json_schema";
      readonly name: string;
      readonly schema: unknown;
      /** Reject anything the schema does not allow, rather than best-effort. */
      readonly strict?: boolean;
    };

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
   * How this endpoint expresses reasoning on the wire. Either a preset NAME for
   * a common case (`qwen` | `deepseek` | `deepseek-local` | `openai` | `none`)
   * or a full `IReasoningProfile` declaring the field paths itself — the latter
   * is what makes an arbitrary model supportable by config rather than by a code
   * change. Omitted → best-effort auto-detection from the url/model.
   *
   * See `reasoning-profile.ts` for the shape and what each preset expands to.
   */
  reasoning?: ReasoningStyle | IReasoningProfile;
  /** Reasoning effort for `deepseek`/`deepseek-local`/`openai` styles (maps to `reasoning_effort`). */
  reasoningEffort?: "low" | "medium" | "high";
  /**
   * OPTIONAL override for guided-decoding (structured tool-call) support. Normally
   * unset: whether `tool_choice` is sent is declared by the resolved reasoning
   * profile's `omitToolChoice` (the `deepseek` cloud preset sets it, because that
   * API 400s on an explicit one). Set `true`/`false` to force the decision either
   * way regardless of the profile.
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

/**
 * A model endpoint answered with an HTTP error.
 *
 * Carries the status so callers can tell a PERMANENT rejection (a malformed or
 * unsupported request — retrying changes nothing) from a transient one. Before
 * this existed, a 400 was an ordinary Error and the loop retried it like a
 * blip: vLLM's V2 runner rejecting `thinking_token_budget` turned every
 * from-scratch build into nine silent no-op turns that read as the model
 * refusing to work.
 */
export class ModelRequestError extends Error {
  readonly status: number;
  /** The server's own explanation, which usually names the offending field. */
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(
      `model request failed: ${String(status)}${detail.length > 0 ? ` ${detail}` : ""}`
    );
    this.name = "ModelRequestError";
    this.status = status;
    this.detail = detail;
  }

  /** 4xx means the request itself is wrong — except 408/429, which are the
   *  server asking for the same request again later. */
  get isPermanent(): boolean {
    return (
      this.status >= 400 &&
      this.status < 500 &&
      this.status !== 408 &&
      this.status !== 429
    );
  }
}
