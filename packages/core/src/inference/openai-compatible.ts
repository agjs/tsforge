import type {
  IChatMessage,
  ICompleteOptions,
  IModelResponse,
  IProvider,
  IOpenAICompatibleConfig,
} from "./inference.types";
import type { TtsrManager } from "../loop/ttsr";
import { PROVIDER_LIMITS } from "./inference.constants";
import { fetchWithRetry } from "./transport";
import { toWire, parseResponse } from "./wire";
import { streamResponse } from "./stream";

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
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (this.cfg.apiKey !== undefined) {
      headers.authorization = `Bearer ${this.cfg.apiKey}`;
    }

    const body = JSON.stringify({
      model: this.cfg.model,
      messages: messages.map(toWire),
      max_tokens: this.cfg.maxTokens ?? PROVIDER_LIMITS.maxTokens,
      temperature: opts.temperature,
      ...(this.cfg.repetitionPenalty === undefined
        ? {}
        : { repetition_penalty: this.cfg.repetitionPenalty }),
      ...(opts.tools === undefined
        ? {}
        : { tools: opts.tools, tool_choice: opts.toolChoice ?? "auto" }),
      ...(opts.enableThinking === undefined
        ? {}
        : { chat_template_kwargs: { enable_thinking: opts.enableThinking } }),
      ...(opts.thinkingTokenBudget === undefined
        ? {}
        : { thinking_token_budget: opts.thinkingTokenBudget }),
      // include_usage → the stream emits a final chunk carrying token `usage`
      // (otherwise a streamed response reports none). Non-stream replies carry it
      // by default.
      ...(streaming
        ? { stream: true, stream_options: { include_usage: true } }
        : {}),
    });

    // Retry transient CONNECTION blips (socket close / unable-to-connect) — the
    // connect happens before any stream starts, so retrying is safe for both
    // streaming and non-streaming. Essential for a long-running CLI; also stops
    // a network hiccup from wrecking an eval run.
    const res = await fetchWithRetry(
      doFetch,
      `${this.cfg.baseUrl}/chat/completions`,
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
      return streamResponse(
        res,
        opts.onToken,
        opts.ttsrManager as TtsrManager | undefined
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
