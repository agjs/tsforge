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

  test("vllm emits chat_template_kwargs.thinking + reasoning_effort", () => {
    const b = body(
      { reasoning: "vllm", reasoningEffort: "low" },
      { enableThinking: true }
    );

    // vLLM reads `thinking` inside the template kwargs — NOT qwen's
    // `enable_thinking`, and NOT DeepSeek cloud's top-level `thinking:{type}`.
    expect(b.chat_template_kwargs).toEqual({ thinking: true });
    expect(b.reasoning_effort).toBe("low");
    expect(b.thinking).toBeUndefined();
  });

  test("vllm can turn thinking OFF (the field vLLM actually honours)", () => {
    const b = body({ reasoning: "vllm" }, { enableThinking: false });

    expect(b.chat_template_kwargs).toEqual({ thinking: false });
  });

  test("vllm omits reasoning fields entirely when nothing is requested", () => {
    const b = body({ reasoning: "vllm" }, {});

    expect(b.chat_template_kwargs).toBeUndefined();
    expect(b.reasoning_effort).toBeUndefined();
  });

  test("a LOCAL deepseek model auto-detects as vllm, not deepseek", () => {
    // Regression: a self-hosted DeepSeek checkpoint used to auto-detect as
    // `deepseek`, so thinking was sent as `thinking:{type}` — which vLLM accepts
    // and silently ignores. Thinking was therefore uncontrollable from config.
    const b = body(
      {
        baseUrl: "http://192.168.20.108:8888/v1",
        model: "deepseek-v4-flash-0731",
      },
      { enableThinking: false }
    );

    expect(b.chat_template_kwargs).toEqual({ thinking: false });
    expect(b.thinking).toBeUndefined();
  });

  test("a CLOUD deepseek model still auto-detects as deepseek", () => {
    const b = body(
      { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-pro" },
      { enableThinking: false }
    );

    expect(b.thinking).toEqual({ type: "disabled" });
    expect(b.chat_template_kwargs).toBeUndefined();
  });

  test("a PUBLIC-host deepseek model stays deepseek (may be a cloud proxy)", () => {
    // Only a private address is evidence of self-hosting. A public hostname can
    // be a reverse proxy in front of DeepSeek cloud, which needs the cloud
    // dialect and the reasoning_content replay — reclassifying it would 400.
    const b = body(
      { baseUrl: "https://proxy.example.com/v1", model: "deepseek-pro-4" },
      { enableThinking: false }
    );

    expect(b.thinking).toEqual({ type: "disabled" });
    expect(b.chat_template_kwargs).toBeUndefined();
  });

  test.each([
    ["http://localhost:8000/v1"],
    ["http://127.0.0.1:8000/v1"],
    ["http://192.168.20.108:8888/v1"],
    ["http://10.0.0.5:8000/v1"],
    ["http://172.16.4.9:8000/v1"],
    ["http://spark2.lan:8888/v1"],
  ])("private host %s auto-detects as vllm", (baseUrl) => {
    const b = body({ baseUrl, model: "deepseek-v4-flash" }, {
      enableThinking: false,
    });

    expect(b.chat_template_kwargs).toEqual({ thinking: false });
    expect(b.thinking).toBeUndefined();
  });

  test("local deepseek auto-sends tool_choice (no config — vLLM accepts it)", () => {
    const b = body(
      { reasoning: "deepseek", baseUrl: "http://localhost:8000/v1" },
      { tools: [{}], toolChoice: "required" }
    );

    expect(b.tools).toBeDefined();
    expect(b.tool_choice).toBe("required");
  });

  test("DeepSeek CLOUD host auto-omits tool_choice (its thinking API 400s on it)", () => {
    const b = body(
      { reasoning: "deepseek", baseUrl: "https://api.deepseek.com/v1" },
      { tools: [{}], toolChoice: "required" }
    );

    expect(b.tools).toBeDefined();
    expect(b.tool_choice).toBeUndefined();
  });

  test("scheme-less DeepSeek cloud baseUrl is still detected (omits tool_choice)", () => {
    const b = body(
      { reasoning: "deepseek", baseUrl: "api.deepseek.com/v1" },
      { tools: [{}], toolChoice: "required" }
    );

    expect(b.tool_choice).toBeUndefined();
  });

  test("non-deepseek still sends tool_choice", () => {
    const b = body({}, { tools: [{}], toolChoice: "required" });

    expect(b.tool_choice).toBe("required");
  });

  test("EMPTY tools array omits both `tools` and `tool_choice` (R1 no-tools call)", () => {
    // Live regression: vLLM/DeepSeek 400 on `tools: []` ("must not be an empty array …
    // omit the field entirely"). The R1 Phase A diagnosis call passes [] to force a
    // tool-less turn — it must OMIT the field, not send an empty array. Fake test
    // providers don't enforce this, so only a live run (or this test) catches it.
    const local = body(
      { reasoning: "deepseek", baseUrl: "http://localhost:8000/v1" },
      { tools: [], toolChoice: "none" }
    );

    expect(local.tools).toBeUndefined();
    expect(local.tool_choice).toBeUndefined();

    // Same for the default (qwen) style.
    const dflt = body({}, { tools: [], toolChoice: "none" });

    expect(dflt.tools).toBeUndefined();
    expect(dflt.tool_choice).toBeUndefined();
  });

  test("guidedDecoding:false forces omit even on a local endpoint", () => {
    const b = body(
      {
        reasoning: "deepseek",
        baseUrl: "http://localhost:8000/v1",
        guidedDecoding: false,
      },
      { tools: [{}], toolChoice: "required" }
    );

    expect(b.tool_choice).toBeUndefined();
  });

  test("guidedDecoding:true forces send even on the cloud host (override)", () => {
    const b = body(
      {
        reasoning: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        guidedDecoding: true,
      },
      { tools: [{}], toolChoice: "required" }
    );

    expect(b.tool_choice).toBe("required");
  });

  test("override tolerates a stringified boolean from hand-edited JSON", () => {
    // Mirror a hand-edited models.json where the override is a JSON string, not a
    // boolean — parsed (not cast) so the test stays type-honest about runtime input.
    const cfg: IOpenAICompatibleConfig = JSON.parse(
      '{"baseUrl":"https://api.deepseek.com/v1","model":"m","reasoning":"deepseek","guidedDecoding":"true"}'
    );
    const b = buildRequestBody(
      cfg,
      MSGS,
      { tools: [{}], toolChoice: "required" },
      false
    );

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

  test("a non-finite tuning param never reaches the wire (NaN/Infinity dropped)", () => {
    // JSON.stringify(NaN) is `null` — a server reads that as an explicit choice,
    // not "unset". The builder must omit the field entirely instead.
    expect("temperature" in body({}, { temperature: NaN })).toBe(false);
    expect("temperature" in body({}, { temperature: Infinity })).toBe(false);
    expect("repetition_penalty" in body({ repetitionPenalty: NaN }, {})).toBe(
      false
    );
    // a finite value still passes through
    expect(body({ repetitionPenalty: 1.1 }, {}).repetition_penalty).toBe(1.1);

    // maxTokens: a non-finite cap must fall back to the provider default, never
    // serialize to `null` (which a server reads as "no limit" / an error).
    expect(body({ maxTokens: NaN }, {}).max_tokens).toBe(16384);
    expect(body({ maxTokens: Infinity }, {}).max_tokens).toBe(16384);
    expect(body({ maxTokens: 2048 }, {}).max_tokens).toBe(2048);

    // thinkingTokenBudget (qwen): a non-finite budget is dropped, not sent as null.
    expect(
      "thinking_token_budget" in body({}, { thinkingTokenBudget: NaN })
    ).toBe(false);
    expect(body({}, { thinkingTokenBudget: 512 }).thinking_token_budget).toBe(
      512
    );
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

  test("auto-detects deepseek from baseUrl (no explicit reasoning) and replays", () => {
    const b = buildRequestBody(
      cfg({ baseUrl: "https://api.deepseek.com/v1" }),
      history,
      {},
      false
    );

    expect(JSON.stringify(b.messages)).toContain(
      '"reasoning_content":"my thought"'
    );
  });

  test("auto-detects deepseek from model id (no explicit reasoning) and replays", () => {
    const b = buildRequestBody(
      cfg({ baseUrl: "https://proxy/v1", model: "deepseek-pro-4" }),
      history,
      {},
      false
    );

    expect(JSON.stringify(b.messages)).toContain(
      '"reasoning_content":"my thought"'
    );
  });

  test("auto-detected deepseek on a non-cloud host still sends tool_choice", () => {
    // Style is auto-detected as deepseek from the model name (for reasoning
    // replay), but the host isn't api.deepseek.com, so tool_choice is sent.
    const b = buildRequestBody(
      cfg({ model: "deepseek-pro-4" }),
      MSGS,
      { tools: [{ type: "function" }] },
      false
    );

    expect(b.tools).toBeDefined();
    expect(b.tool_choice).toBe("auto");
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
