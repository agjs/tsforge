import type {
  IChatMessage,
  ICompleteOptions,
  IOpenAICompatibleConfig,
  ReasoningStyle,
} from "./inference.types";
import { PROVIDER_LIMITS } from "./inference.constants";
import { toWire } from "./wire";

/** Interpolate `${VAR}` references from `env` into a string (missing → ""). */
function interpolateEnv(
  value: string,
  env: Readonly<Record<string, string | undefined>>
): string {
  return value.replace(
    /\$\{([A-Za-z0-9_]+)\}/g,
    (_m: string, name: string) => env[name] ?? ""
  );
}

/** True when this config talks to DeepSeek's thinking API (explicit `reasoning:
 *  "deepseek"` or auto-detected from the url/model). DeepSeek 400s if thinking is
 *  toggled mid-conversation, so the provider latches one mode per session. */
export function isDeepseekStyle(cfg: IOpenAICompatibleConfig): boolean {
  return style(cfg) === "deepseek";
}

function style(cfg: IOpenAICompatibleConfig): ReasoningStyle {
  if (cfg.reasoning !== undefined) {
    return cfg.reasoning;
  }

  // Auto-detect DeepSeek when not explicitly configured, so its thinking-mode
  // round-trip works out of the box: DeepSeek requires each prior assistant
  // turn's `reasoning_content` replayed, and 400s otherwise ("The
  // reasoning_content in the thinking mode must be passed back to the API").
  // Without this, a DeepSeek model added with just { baseUrl, model } gets the
  // `qwen` default, which strips reasoning_content on replay → that 400.
  if (`${cfg.baseUrl} ${cfg.model}`.toLowerCase().includes("deepseek")) {
    return "deepseek";
  }

  return "qwen";
}

/** Provider-specific reasoning/thinking fields for the request body. */
function reasoningFields(
  cfg: IOpenAICompatibleConfig,
  opts: ICompleteOptions
): Record<string, unknown> {
  switch (style(cfg)) {
    case "qwen":
      return {
        ...(opts.enableThinking === undefined
          ? {}
          : { chat_template_kwargs: { enable_thinking: opts.enableThinking } }),
        ...(opts.thinkingTokenBudget === undefined ||
        !Number.isFinite(opts.thinkingTokenBudget)
          ? {}
          : { thinking_token_budget: opts.thinkingTokenBudget }),
      };
    case "deepseek":
      return {
        ...(opts.enableThinking === undefined
          ? {}
          : {
              thinking: {
                type: opts.enableThinking ? "enabled" : "disabled",
              },
            }),
        ...(cfg.reasoningEffort === undefined
          ? {}
          : { reasoning_effort: cfg.reasoningEffort }),
      };
    case "openai":
      return cfg.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: cfg.reasoningEffort };
    case "none":
      return {};
  }
}

/** The output-token cap field — o-series renamed `max_tokens` → `max_completion_tokens`. */
function tokenCapField(cfg: IOpenAICompatibleConfig): Record<string, number> {
  // A NaN/Infinity maxTokens (bad config/env) would JSON.stringify to `null`,
  // which a server reads as an explicit choice, not "unset" — fall back to the
  // provider default instead (matches the temperature/repetitionPenalty guard).
  const configured = cfg.maxTokens;
  const max =
    configured !== undefined && Number.isFinite(configured)
      ? configured
      : PROVIDER_LIMITS.maxTokens;

  return style(cfg) === "openai"
    ? { max_completion_tokens: max }
    : { max_tokens: max };
}

/** The `tools` (+ `tool_choice`) request fields, with provider constraints
 *  applied: DeepSeek's CLOUD thinking API rejects an explicit `tool_choice`, so
 *  omit it there (the model still gets the tools and decides). A guided-decoding-
 *  capable endpoint (local vLLM serving e.g. DeepSeek-V4-Flash) accepts it and
 *  grammar-constrains the call — so `guidedDecoding` opts that endpoint back into
 *  sending `tool_choice`, which forces a well-formed call instead of free-form
 *  text the harness would otherwise have to salvage. */
function toolsBlock(
  cfg: IOpenAICompatibleConfig,
  opts: ICompleteOptions
): Record<string, unknown> {
  if (opts.tools === undefined) {
    return {};
  }

  if (style(cfg) === "deepseek" && cfg.guidedDecoding !== true) {
    return { tools: opts.tools };
  }

  return { tools: opts.tools, tool_choice: opts.toolChoice ?? "auto" };
}

/** Build the request body object (pure). Field order keeps the qwen default
 *  byte-for-byte identical; `extraBody` is merged last so it can override
 *  anything for a fully custom provider. */
export function buildRequestBody(
  cfg: IOpenAICompatibleConfig,
  messages: IChatMessage[],
  opts: ICompleteOptions,
  streaming: boolean
): Record<string, unknown> {
  // o-series rejects `temperature` entirely; everywhere else send it only when set
  // AND finite — a NaN/Infinity (bad config/env) would JSON.stringify to `null`,
  // which a server reads as an explicit choice, not "unset". Drop it instead.
  const omitTemperature =
    style(cfg) === "openai" ||
    opts.temperature === undefined ||
    !Number.isFinite(opts.temperature);

  // DeepSeek's thinking mode requires each prior assistant turn's
  // `reasoning_content` replayed; other providers don't want it.
  const includeReasoning = style(cfg) === "deepseek";

  return {
    model: cfg.model,
    messages: messages.map((m) => toWire(m, includeReasoning)),
    ...tokenCapField(cfg),
    ...(omitTemperature ? {} : { temperature: opts.temperature }),
    ...(cfg.repetitionPenalty === undefined ||
    !Number.isFinite(cfg.repetitionPenalty)
      ? {}
      : { repetition_penalty: cfg.repetitionPenalty }),
    ...toolsBlock(cfg, opts),
    ...reasoningFields(cfg, opts),
    ...(streaming
      ? { stream: true, stream_options: { include_usage: true } }
      : {}),
    ...(cfg.extraBody ?? {}),
  };
}

/** Build request headers: JSON + Bearer auth (when a key is set) + any
 *  `extraHeaders` (with `${VAR}` interpolation), which can override the defaults. */
export function buildRequestHeaders(
  cfg: IOpenAICompatibleConfig,
  env: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (cfg.apiKey !== undefined) {
    headers.authorization = `Bearer ${cfg.apiKey}`;
  }

  for (const [key, value] of Object.entries(cfg.extraHeaders ?? {})) {
    headers[key] = interpolateEnv(value, env);
  }

  return headers;
}

/** Normalize the chat-completions URL: trim trailing slashes and don't
 *  double-append when the baseUrl already ends with the path. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");

  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}
