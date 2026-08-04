import type {
  IChatMessage,
  ICompleteOptions,
  IModelResponse,
  IProvider,
  IOpenAICompatibleConfig,
} from "./inference.types";
import { ModelRequestError } from "./inference.types";
import { PROVIDER_LIMITS } from "./inference.constants";
import { fetchWithRetry } from "./transport";
import { parseResponse } from "./wire";
import { streamResponse } from "./stream";
import {
  buildRequestBody,
  buildRequestHeaders,
  chatCompletionsUrl,
  latchesThinking,
} from "./request";

export { salvageToolCalls, salvageFusedToolName } from "./wire";

/** A finite, non-negative number, or the fallback — for timing knobs that flow
 *  into AbortSignal.timeout() (throws a RangeError outside [0, MAX_SAFE_INTEGER]).
 *  Undefined/NaN/Infinity/negative all degrade to the fallback. */
function finiteNonNegative(
  value: number | undefined,
  fallback: number
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/**
 * Talks to any OpenAI-compatible `/chat/completions` endpoint — which Ollama,
 * vLLM, and llama.cpp all expose for a local Qwen3.6. Supports streaming: pass
 * `onToken` to receive reasoning + content tokens as they arrive. The wire
 * mapping lives in ./wire, the SSE assembly in ./stream, and connection retry in
 * ./transport — this class just orchestrates one request.
 */
export class OpenAICompatibleProvider implements IProvider {
  /** DeepSeek 400s when thinking is toggled mid-conversation: a thinking-ENABLED
   *  request rejects a history whose earlier assistant turns have no
   *  `reasoning_content`. The harness runs interactive turns thinking-OFF (fast
   *  streaming) and flips thinking ON for gate-repair — on DeepSeek that mixed
   *  history is rejected. So for DeepSeek we LATCH the session's first thinking
   *  mode and reuse it for every later turn (never flip). Other providers keep
   *  per-turn control. `pinned` records whether the latch has been set. */
  private thinkingPinned = false;
  private pinnedThinking: boolean | undefined;

  /** Optional fields THIS endpoint has already rejected as unsupported.
   *
   *  Retrying per call fixes the call but keeps sending a request the server
   *  will refuse — measured on a live box: ~300 rejections an hour, every one
   *  a wasted round trip, and every one an error in the server's own metrics
   *  pointing at a bug that was already handled. Learning it once takes that
   *  to a single rejection per endpoint. */
  private readonly unsupported = new Set<keyof ICompleteOptions>();

  constructor(private cfg: IOpenAICompatibleConfig) {}

  /** For DeepSeek, force every turn to the session's first thinking mode (see
   *  `thinkingPinned`); a no-op for other providers. */
  private withPinnedThinking(opts: ICompleteOptions): ICompleteOptions {
    if (!latchesThinking(this.cfg)) {
      return opts;
    }

    if (!this.thinkingPinned) {
      this.pinnedThinking = opts.enableThinking;
      this.thinkingPinned = true;
    }

    return { ...opts, enableThinking: this.pinnedThinking };
  }

  /** Hot-swap the endpoint/model/key (used by `/model` to switch live): the
   *  running session keeps this provider reference and picks up the new config on
   *  its next request — no restart. */
  reconfigure(cfg: IOpenAICompatibleConfig): void {
    this.cfg = cfg;
    // What one endpoint refuses says nothing about the next one.
    this.unsupported.clear();
  }

  /** The current config — read by the CLI for the model/endpoint status line. */
  get config(): IOpenAICompatibleConfig {
    return this.cfg;
  }

  async complete(
    messages: IChatMessage[],
    opts: ICompleteOptions = {}
  ): Promise<IModelResponse> {
    const known = this.withoutKnownUnsupported(opts);

    try {
      return await this.send(messages, known);
    } catch (err) {
      // An endpoint that rejects ONE optional field would otherwise fail every
      // call for the life of the process. vLLM's V2 model runner does exactly
      // this with `thinking_token_budget`, which the scratch path sets by
      // default — so every from-scratch build 400s, and (before this) each
      // failure looked like the model simply saying nothing.
      const offending = unsupportedField(known, err);

      if (offending === null) {
        throw err;
      }

      // Remember, so the next call never asks for it again.
      this.unsupported.add(offending);

      return await this.send(messages, this.withoutKnownUnsupported(known));
    }
  }

  private withoutKnownUnsupported(opts: ICompleteOptions): ICompleteOptions {
    if (this.unsupported.size === 0) {
      return opts;
    }

    // Cleared to undefined rather than filtered out: every one of these is an
    // optional field, and the request builder already treats undefined as
    // "don't send". Walking the KNOWN field list keeps this typed — filtering
    // `Object.entries` would hand back plain strings.
    const next: ICompleteOptions = { ...opts };

    for (const { option } of OPTIONAL_FIELDS) {
      if (this.unsupported.has(option)) {
        next[option] = undefined;
      }
    }

    return next;
  }

  private async send(
    messages: IChatMessage[],
    opts: ICompleteOptions
  ): Promise<IModelResponse> {
    const effectiveOpts = this.withPinnedThinking(opts);
    const doFetch = this.cfg.fetch ?? fetch;
    const streaming = effectiveOpts.onToken !== undefined;
    const headers = buildRequestHeaders(this.cfg);
    const body = JSON.stringify(
      buildRequestBody(this.cfg, messages, effectiveOpts, streaming)
    );

    // Retry transient CONNECTION blips (socket close / unable-to-connect) — the
    // connect happens before any stream starts, so retrying is safe for both
    // streaming and non-streaming. Essential for a long-running CLI; also stops
    // a network hiccup from wrecking an eval run.
    const res = await fetchWithRetry(
      doFetch,
      chatCompletionsUrl(this.cfg.baseUrl),
      headers,
      body,
      // Guard the timing knobs the same way request.ts guards its numeric params:
      // a NaN/Infinity/negative value reaches AbortSignal.timeout() downstream and
      // throws a RangeError, killing the request. Fall back to the default instead.
      finiteNonNegative(this.cfg.timeoutMs, PROVIDER_LIMITS.requestTimeoutMs),
      effectiveOpts.signal,
      finiteNonNegative(this.cfg.connectRetryMs, PROVIDER_LIMITS.connectRetryMs)
    );

    if (!res.ok) {
      throw new ModelRequestError(res.status, await responseDetail(res));
    }

    if (effectiveOpts.onToken !== undefined) {
      return streamResponse(
        res,
        effectiveOpts.onToken,
        effectiveOpts.ttsrManager
      );
    }

    const data: unknown = await res.json();

    return parseResponse(data);
  }
}

/** Optional request fields, paired with the option that produces them, so a
 *  "not supported" rejection can be answered by dropping just that one. */
const OPTIONAL_FIELDS: readonly {
  wire: string;
  option: keyof ICompleteOptions;
}[] = [
  { wire: "thinking_token_budget", option: "thinkingTokenBudget" },
  { wire: "response_format", option: "responseFormat" },
  { wire: "reasoning_effort", option: "reasoningEffort" },
];

/**
 * The same options minus one field the server just said it does not support,
 * or null when this error is not that.
 *
 * Deliberately narrow: only a 4xx that NAMES a field we sent, and only fields
 * that are optimisations rather than instructions. Retrying blind would hide
 * real request errors; dropping `messages` or `tools` would silently change
 * what was asked.
 */
function unsupportedField(
  opts: ICompleteOptions,
  err: unknown
): keyof ICompleteOptions | null {
  if (!(err instanceof ModelRequestError) || !err.isPermanent) {
    return null;
  }

  const detail = err.detail.toLowerCase();
  const offending = OPTIONAL_FIELDS.find(
    (f) =>
      opts[f.option] !== undefined &&
      detail.includes(f.wire) &&
      (detail.includes("not supported") ||
        detail.includes("unsupported") ||
        detail.includes("not yet supported") ||
        detail.includes("unrecognized") ||
        detail.includes("unknown"))
  );

  return offending?.option ?? null;
}

async function responseDetail(res: Response): Promise<string> {
  try {
    return (await res.text()).trim().slice(0, 1000);
  } catch {
    return "";
  }
}
