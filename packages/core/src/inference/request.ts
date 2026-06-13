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

function style(cfg: IOpenAICompatibleConfig): ReasoningStyle {
  return cfg.reasoning ?? "qwen";
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
        ...(opts.thinkingTokenBudget === undefined
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
  const max = cfg.maxTokens ?? PROVIDER_LIMITS.maxTokens;

  return style(cfg) === "openai"
    ? { max_completion_tokens: max }
    : { max_tokens: max };
}

/** The `tools` (+ `tool_choice`) request fields, with provider constraints
 *  applied: DeepSeek's thinking mode rejects an explicit `tool_choice`, so omit
 *  it entirely there (the model still gets the tools and decides). */
function toolsBlock(
  cfg: IOpenAICompatibleConfig,
  opts: ICompleteOptions
): Record<string, unknown> {
  if (opts.tools === undefined) {
    return {};
  }

  if (style(cfg) === "deepseek") {
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
  // o-series rejects `temperature` entirely; everywhere else send it only when set.
  const omitTemperature =
    style(cfg) === "openai" || opts.temperature === undefined;

  // DeepSeek's thinking mode requires each prior assistant turn's
  // `reasoning_content` replayed; other providers don't want it.
  const includeReasoning = style(cfg) === "deepseek";

  return {
    model: cfg.model,
    messages: messages.map((m) => toWire(m, includeReasoning)),
    ...tokenCapField(cfg),
    ...(omitTemperature ? {} : { temperature: opts.temperature }),
    ...(cfg.repetitionPenalty === undefined
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
