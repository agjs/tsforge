import type {
  IChatMessage,
  ICompleteOptions,
  IModelResponse,
  IProvider,
  IOpenAICompatibleConfig,
} from "./inference.types";
import { PROVIDER_LIMITS } from "./inference.constants";
import { fetchWithRetry } from "./transport";
import { parseResponse } from "./wire";
import { streamResponse } from "./stream";
import {
  buildRequestBody,
  buildRequestHeaders,
  chatCompletionsUrl,
  isDeepseekStyle,
} from "./request";

export { salvageToolCalls, salvageFusedToolName } from "./wire";

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

  constructor(private cfg: IOpenAICompatibleConfig) {}

  /** For DeepSeek, force every turn to the session's first thinking mode (see
   *  `thinkingPinned`); a no-op for other providers. */
  private withPinnedThinking(opts: ICompleteOptions): ICompleteOptions {
    if (!isDeepseekStyle(this.cfg)) {
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
  }

  /** The current config — read by the CLI for the model/endpoint status line. */
  get config(): IOpenAICompatibleConfig {
    return this.cfg;
  }

  async complete(
    messages: IChatMessage[],
    opts: ICompleteOptions = {}
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
      this.cfg.timeoutMs ?? PROVIDER_LIMITS.requestTimeoutMs,
      effectiveOpts.signal,
      this.cfg.connectRetryMs ?? PROVIDER_LIMITS.connectRetryMs
    );

    if (!res.ok) {
      const detail = await responseDetail(res);

      throw new Error(
        `model request failed: ${res.status}${detail.length > 0 ? ` ${detail}` : ""}`
      );
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

async function responseDetail(res: Response): Promise<string> {
  try {
    return (await res.text()).trim().slice(0, 1000);
  } catch {
    return "";
  }
}
