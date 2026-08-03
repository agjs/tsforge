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
  latchesThinking,
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

  test("deepseek-local emits chat_template_kwargs.thinking + reasoning_effort", () => {
    const b = body(
      { reasoning: "deepseek-local", reasoningEffort: "low" },
      { enableThinking: true }
    );

    // vLLM reads `thinking` inside the template kwargs — NOT qwen's
    // `enable_thinking`, and NOT DeepSeek cloud's top-level `thinking:{type}`.
    // Effort rides in the SAME object (upstream's server default is literally
    // `{"thinking":true,"reasoning_effort":"low"}`), not top-level.
    expect(b.chat_template_kwargs).toEqual({
      thinking: true,
      reasoning_effort: "low",
    });
    expect(b.reasoning_effort).toBeUndefined();
    expect(b.thinking).toBeUndefined();
  });

  test("deepseek-local sends effort even when thinking is not explicitly toggled", () => {
    const b = body(
      { reasoning: "deepseek-local", reasoningEffort: "high" },
      {}
    );

    expect(b.chat_template_kwargs).toEqual({ reasoning_effort: "high" });
  });

  test("deepseek-local can turn thinking OFF (the field vLLM actually honours)", () => {
    const b = body({ reasoning: "deepseek-local" }, { enableThinking: false });

    expect(b.chat_template_kwargs).toEqual({ thinking: false });
  });

  test("deepseek-local omits reasoning fields entirely when nothing is requested", () => {
    const b = body({ reasoning: "deepseek-local" }, {});

    expect(b.chat_template_kwargs).toBeUndefined();
    expect(b.reasoning_effort).toBeUndefined();
  });

  test("a LOCAL deepseek model auto-detects as deepseek-local, not deepseek", () => {
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

  test("deepseek-local forwards thinking_token_budget (a vLLM param, like qwen)", () => {
    const b = body(
      { reasoning: "deepseek-local" },
      { enableThinking: true, thinkingTokenBudget: 2048 }
    );

    expect(b.thinking_token_budget).toBe(2048);
  });

  test.each([
    ["http://localhost:8000/v1"],
    ["http://127.0.0.1:8000/v1"],
    ["http://192.168.20.108:8888/v1"],
    ["http://10.0.0.5:8000/v1"],
    ["http://172.16.4.9:8000/v1"],
    ["http://169.254.7.7:8000/v1"],
    ["http://spark2.lan:8888/v1"],
    // IPv6: URL.hostname KEEPS the brackets, so these only pass if stripped.
    ["http://[::1]:8000/v1"],
    ["http://[fd12:3456::1]:8000/v1"],
    ["http://[fe80::1]:8000/v1"],
    ["http://[::ffff:192.168.1.9]:8000/v1"],
  ])("private host %s auto-detects as deepseek-local", (baseUrl) => {
    const b = body(
      { baseUrl, model: "deepseek-v4-flash" },
      {
        enableThinking: false,
      }
    );

    expect(b.chat_template_kwargs).toEqual({ thinking: false });
    expect(b.thinking).toBeUndefined();
  });

  test.each([
    ["https://api.deepseek.com/v1"],
    ["https://proxy.example.com/v1"],
    ["http://8.8.8.8:8000/v1"],
    ["http://[2001:4860::8888]:8000/v1"],
    // DNS labels that COLLIDE with the IPv6 private prefixes. The range checks
    // must be gated on the host actually being an IPv6 literal, or these public
    // names get misread as unique-local/link-local and silently switch dialect.
    ["https://fda.gov/v1"],
    ["https://fcm.example.com/v1"],
    ["https://fd12.corp.example.com/v1"],
    ["https://fe80.example.com/v1"],
    ["https://feb-proxy.example.com/v1"],
  ])("public host %s stays deepseek", (baseUrl) => {
    const b = body(
      { baseUrl, model: "deepseek-v4-flash" },
      {
        enableThinking: false,
      }
    );

    expect(b.thinking).toEqual({ type: "disabled" });
    expect(b.chat_template_kwargs).toBeUndefined();
  });

  test("a private deepseek endpoint does not latch thinking", () => {
    // The session latch (withPinnedThinking) keys off isDeepseekStyle. If a
    // private host were still classified deepseek, per-turn thinking control
    // would be silently pinned to the session's first value.
    expect(
      latchesThinking(
        cfg({
          baseUrl: "http://192.168.20.108:8888/v1",
          model: "deepseek-v4-flash",
        })
      )
    ).toBe(false);

    expect(
      latchesThinking(
        cfg({
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-v4-pro",
        })
      )
    ).toBe(true);
  });

  test("private deepseek does NOT replay reasoning_content", () => {
    // includeReasoning is `style === "deepseek"`. Replay exists to stop the
    // CLOUD API 400ing; a local vLLM neither needs nor expects it.
    const hist: IChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ans", reasoningContent: "my thought" },
    ];

    const local = buildRequestBody(
      cfg({
        baseUrl: "http://192.168.20.108:8888/v1",
        model: "deepseek-v4-flash",
      }),
      hist,
      {},
      false
    );

    expect(JSON.stringify(local.messages)).not.toContain("reasoning_content");

    // ...but a public/proxied deepseek still must replay it.
    const proxied = buildRequestBody(
      cfg({ baseUrl: "https://proxy.example.com/v1", model: "deepseek-pro-4" }),
      hist,
      {},
      false
    );

    expect(JSON.stringify(proxied.messages)).toContain(
      '"reasoning_content":"my thought"'
    );
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

describe("buildRequestBody: declarative reasoning profiles", () => {
  // The point of the profile: a model nobody hardcoded, configured from data.
  const custom = {
    thinking: { path: "params.reasoning.enabled" },
    effort: "params.reasoning.level",
    budget: "params.reasoning.max_tokens",
    tokenCap: "output_limit",
  };

  test("writes every declared field at its dot path, creating nesting", () => {
    const b = body(
      { reasoning: custom, reasoningEffort: "high", maxTokens: 4096 },
      { enableThinking: true, thinkingTokenBudget: 512 }
    );

    expect(b.params).toEqual({
      reasoning: { enabled: true, level: "high", max_tokens: 512 },
    });
    expect(b.output_limit).toBe(4096);
    expect(b.max_tokens).toBeUndefined();
  });

  test("a control the profile omits is never sent", () => {
    // No `thinking` path declared → the endpoint has no such toggle, so asking
    // for thinking must produce nothing rather than a field it would ignore.
    const b = body(
      { reasoning: { effort: "effort" } },
      { enableThinking: true, thinkingTokenBudget: 999 }
    );

    expect(b.thinking).toBeUndefined();
    expect(b.chat_template_kwargs).toBeUndefined();
    expect(b.thinking_token_budget).toBeUndefined();
  });

  test("onValue/offValue express non-boolean flags", () => {
    const shape = {
      thinking: {
        path: "mode",
        onValue: { kind: "deep" },
        offValue: { kind: "off" },
      },
    };

    expect(body({ reasoning: shape }, { enableThinking: true }).mode).toEqual({
      kind: "deep",
    });
    expect(body({ reasoning: shape }, { enableThinking: false }).mode).toEqual({
      kind: "off",
    });
  });

  test("profile can declare the temperature and tool_choice quirks", () => {
    const b = body(
      { reasoning: { omitTemperature: true, omitToolChoice: true } },
      { temperature: 0.5, tools: [{}], toolChoice: "required" }
    );

    expect(b.temperature).toBeUndefined();
    expect(b.tools).toBeDefined();
    expect(b.tool_choice).toBeUndefined();
  });

  test("presets are just profiles — deepseek still latches, custom does not", () => {
    expect(
      latchesThinking(cfg({ baseUrl: "https://api.deepseek.com/v1" }))
    ).toBe(true);
    expect(latchesThinking(cfg({ reasoning: custom }))).toBe(false);
    expect(latchesThinking(cfg({ reasoning: { latchThinking: true } }))).toBe(
      true
    );
  });
});

describe("buildRequestBody: profile edge cases", () => {
  test("tokenCap and a reasoning field under a SHARED parent both survive", () => {
    // Regression: these were built as separate objects and shallow-spread, so
    // the second `params` replaced the first and one field vanished silently.
    const b = body(
      {
        reasoning: {
          tokenCap: "params.output_limit",
          effort: "params.reasoning.level",
          thinking: { path: "params.reasoning.enabled" },
        },
        reasoningEffort: "high",
        maxTokens: 4096,
      },
      { enableThinking: true }
    );

    expect(b.params).toEqual({
      output_limit: 4096,
      reasoning: { level: "high", enabled: true },
    });
  });

  test.each([
    ["http://100.64.0.1:8000/v1"],
    ["http://100.127.255.254:8000/v1"],
  ])("CGNAT host %s is private (Tailscale-style self-host)", (baseUrl) => {
    const b = body(
      { baseUrl, model: "deepseek-v4-flash" },
      { enableThinking: false }
    );

    expect(b.chat_template_kwargs).toEqual({ thinking: false });
  });

  test("100.63.x and 100.128.x are OUTSIDE CGNAT and stay public", () => {
    for (const baseUrl of [
      "http://100.63.0.1:8000/v1",
      "http://100.128.0.1:8000/v1",
    ]) {
      const b = body(
        { baseUrl, model: "deepseek-v4-flash" },
        { enableThinking: false }
      );

      expect(b.thinking).toEqual({ type: "disabled" });
    }
  });

  test.each([
    [null, "null"],
    ["qwne", "a typo'd preset"],
    [{ budegt: "x" }, "a misspelled profile key"],
    [{ thinking: true }, "a malformed thinking flag"],
    [42, "a number"],
  ])("a bad reasoning value (%s) falls back instead of throwing", (bad) => {
    // The loader rejects these loudly; this is the last line of defence so a
    // hand-edited registry cannot kill a live turn mid-flight.
    // A hand-edited registry can hold anything, so the value is injected the
    // way JSON.parse would deliver it rather than through the typed field.
    const raw: Record<string, unknown> = {
      baseUrl: "https://x/v1",
      model: "m",
      reasoning: bad,
    };
    const build = () =>
      buildRequestBody(
        { ...cfg(), ...raw },
        MSGS,
        { enableThinking: true },
        false
      );

    expect(build).not.toThrow();
    // Falls back to the qwen auto-preset for a non-deepseek model.
    expect(build().chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  test("an unsafe path in a profile writes nothing, and never pollutes", () => {
    const b = body(
      { reasoning: { thinking: { path: "__proto__.polluted" } } },
      { enableThinking: true }
    );

    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(b.polluted).toBeUndefined();
  });
});

describe("tool_choice suppression is gated on the DeepSeek CLOUD dialect", () => {
  const cloud = "https://api.deepseek.com/v1";
  const withTools: ICompleteOptions = { tools: [{}], toolChoice: "required" };

  test("auto-detected cloud deepseek omits tool_choice", () => {
    expect(
      body({ baseUrl: cloud, model: "deepseek-v4-pro" }, withTools).tool_choice
    ).toBeUndefined();
  });

  test.each([["none"], ["qwen"], ["openai"]] as const)(
    "an explicit %s profile on the cloud host STILL sends tool_choice",
    (reasoning) => {
      // Regression guard: dropping the dialect gate made the host heuristic
      // apply to every profile, silently removing the escape hatch for
      // non-thinking DeepSeek cloud tool use.
      expect(
        body({ baseUrl: cloud, model: "deepseek-v4-pro", reasoning }, withTools)
          .tool_choice
      ).toBe("required");
    }
  );

  test("a custom profile on the cloud host still sends tool_choice", () => {
    expect(
      body(
        {
          baseUrl: cloud,
          model: "deepseek-v4-pro",
          reasoning: { effort: "reasoning_effort" },
        },
        withTools
      ).tool_choice
    ).toBe("required");
  });

  test("a profile may declare the suppression itself, on any host", () => {
    expect(
      body(
        {
          baseUrl: "http://localhost:8000/v1",
          reasoning: { omitToolChoice: true },
        },
        withTools
      ).tool_choice
    ).toBeUndefined();
  });
});
