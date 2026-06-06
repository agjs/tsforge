import type {
  IChatMessage,
  ICompleteOptions,
  IModelResponse,
  IProvider,
  IOpenAICompatibleConfig,
} from "./inference.types";
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
  constructor(private readonly cfg: IOpenAICompatibleConfig) {}

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
      ...(streaming ? { stream: true } : {}),
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
      this.cfg.timeoutMs ?? PROVIDER_LIMITS.requestTimeoutMs
    );

    if (!res.ok) {
      throw new Error(`model request failed: ${res.status}`);
    }

    if (opts.onToken !== undefined) {
      return streamResponse(res, opts.onToken);
    }

    const data: unknown = await res.json();

    return parseResponse(data);
  }
}
