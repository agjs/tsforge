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
} from "./request";

export { salvageToolCalls } from "./wire";

/**
 * Talks to any OpenAI-compatible `/chat/completions` endpoint — which Ollama,
 * vLLM, and llama.cpp all expose for a local Qwen3.6. Supports streaming: pass
 * `onToken` to receive reasoning + content tokens as they arrive. The wire
 * mapping lives in ./wire, the SSE assembly in ./stream, and connection retry in
 * ./transport — this class just orchestrates one request.
 */
export class OpenAICompatibleProvider implements IProvider {
  constructor(private cfg: IOpenAICompatibleConfig) {}

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
    const doFetch = this.cfg.fetch ?? fetch;
    const streaming = opts.onToken !== undefined;
    const headers = buildRequestHeaders(this.cfg);
    const body = JSON.stringify(
      buildRequestBody(this.cfg, messages, opts, streaming)
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
      opts.signal
    );

    if (!res.ok) {
      const detail = await responseDetail(res);

      throw new Error(
        `model request failed: ${res.status}${detail.length > 0 ? ` ${detail}` : ""}`
      );
    }

    if (opts.onToken !== undefined) {
      return streamResponse(res, opts.onToken, opts.ttsrManager);
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
