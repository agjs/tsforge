import { test, expect, describe } from "bun:test";
import type {
  IChatMessage,
  IOpenAICompatibleConfig,
  ICompleteOptions,
} from "../src/inference";
import {
  buildRequestBody,
  buildRequestHeaders,
  chatCompletionsUrl,
} from "../src/inference/request";

const MSGS: IChatMessage[] = [{ role: "user", content: "hi" }];

function cfg(
  over: Partial<IOpenAICompatibleConfig> = {}
): IOpenAICompatibleConfig {
  return { baseUrl: "https://x/v1", model: "m", ...over };
}

function body(
  over: Partial<IOpenAICompatibleConfig>,
  opts: ICompleteOptions,
  streaming = false
): Record<string, unknown> {
  return buildRequestBody(cfg(over), MSGS, opts, streaming);
}

describe("buildRequestBody: reasoning styles", () => {
  test("qwen (default) emits chat_template_kwargs + thinking_token_budget", () => {
    const b = body({}, { enableThinking: true, thinkingTokenBudget: 2048 });

    expect(b.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(b.thinking_token_budget).toBe(2048);
    expect(b.max_tokens).toBeDefined();
    expect(b.thinking).toBeUndefined();
  });

  test("deepseek emits thinking:{type} + reasoning_effort, no qwen fields", () => {
    const b = body(
      { reasoning: "deepseek", reasoningEffort: "high" },
      { enableThinking: true }
    );

    expect(b.thinking).toEqual({ type: "enabled" });
    expect(b.reasoning_effort).toBe("high");
    expect(b.chat_template_kwargs).toBeUndefined();
  });

  test("deepseek sends tools but omits tool_choice (thinking mode rejects it)", () => {
    const b = body(
      { reasoning: "deepseek" },
      { tools: [{}], toolChoice: "required" }
    );

    expect(b.tools).toBeDefined();
    expect(b.tool_choice).toBeUndefined();
  });

  test("non-deepseek still sends tool_choice", () => {
    const b = body({}, { tools: [{}], toolChoice: "required" });

    expect(b.tool_choice).toBe("required");
  });

  test("openai uses max_completion_tokens, reasoning_effort, and omits temperature", () => {
    const b = body(
      { reasoning: "openai", reasoningEffort: "medium" },
      { temperature: 0 }
    );

    expect(b.max_completion_tokens).toBeDefined();
    expect(b.max_tokens).toBeUndefined();
    expect(b.reasoning_effort).toBe("medium");
    expect(b.temperature).toBeUndefined();
  });

  test("none emits no reasoning fields", () => {
    const b = body({ reasoning: "none" }, { enableThinking: true });

    expect(b.chat_template_kwargs).toBeUndefined();
    expect(b.thinking).toBeUndefined();
    expect(b.reasoning_effort).toBeUndefined();
  });
});

describe("buildRequestBody: base body", () => {
  test("temperature omitted when undefined", () => {
    expect(body({}, {}).temperature).toBeUndefined();
    expect(body({}, { temperature: 0.5 }).temperature).toBe(0.5);
  });

  test("extraBody is merged last and overrides built-ins", () => {
    const b = body(
      { extraBody: { temperature: 0.9, custom_flag: true } },
      { temperature: 0 }
    );

    expect(b.temperature).toBe(0.9); // extraBody wins
    expect(b.custom_flag).toBe(true);
  });

  test("streaming adds stream + include_usage", () => {
    const b = body({}, {}, true);

    expect(b.stream).toBe(true);
    expect(b.stream_options).toEqual({ include_usage: true });
  });

  test("qwen default request is unchanged in shape", () => {
    const b = body({}, { temperature: 0, enableThinking: false });

    expect(b.model).toBe("m");
    expect(Array.isArray(b.messages)).toBe(true);
    expect(b.max_tokens).toBeDefined();
    expect(b.temperature).toBe(0);
    expect(b.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});

describe("buildRequestHeaders", () => {
  test("sets Bearer auth when a key is present", () => {
    expect(buildRequestHeaders(cfg({ apiKey: "k" })).authorization).toBe(
      "Bearer k"
    );
  });

  test("merges extraHeaders with ${VAR} interpolation, overriding defaults", () => {
    const h = buildRequestHeaders(
      cfg({
        extraHeaders: { "api-key": "${MY_KEY}", "content-type": "text/x" },
      }),
      { MY_KEY: "secret" }
    );

    expect(h["api-key"]).toBe("secret");
    expect(h["content-type"]).toBe("text/x"); // overrides the default
  });
});

describe("reasoning_content round-trip", () => {
  const history: IChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "ans", reasoningContent: "my thought" },
  ];

  test("deepseek replays assistant reasoning_content", () => {
    const b = buildRequestBody(
      cfg({ reasoning: "deepseek" }),
      history,
      {},
      false
    );

    expect(JSON.stringify(b.messages)).toContain(
      '"reasoning_content":"my thought"'
    );
  });

  test("non-deepseek (qwen) does NOT replay reasoning_content", () => {
    const b = buildRequestBody(cfg({}), history, {}, false);

    expect(JSON.stringify(b.messages)).not.toContain("reasoning_content");
  });
});

describe("chatCompletionsUrl", () => {
  test("appends the path", () => {
    expect(chatCompletionsUrl("https://api.deepseek.com/v1")).toBe(
      "https://api.deepseek.com/v1/chat/completions"
    );
  });

  test("trims a trailing slash and never double-appends", () => {
    expect(chatCompletionsUrl("http://localhost:8000/v1/")).toBe(
      "http://localhost:8000/v1/chat/completions"
    );
    expect(chatCompletionsUrl("https://x/v1/chat/completions")).toBe(
      "https://x/v1/chat/completions"
    );
  });
});
