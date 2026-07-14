import { test, expect, describe } from "bun:test";
import type {
  IChatMessage,
  IOpenAICompatibleConfig,
  ICompleteOptions,
} from "../src/inference";
import { buildRequestBody } from "../src/inference/request";

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

describe("buildRequestBody: per-call reasoningEffort override", () => {
  test("per-call reasoningEffort overrides config reasoningEffort for deepseek", () => {
    const b = body(
      { reasoning: "deepseek", reasoningEffort: "low" },
      { reasoningEffort: "high" }
    );

    expect(b.reasoning_effort).toBe("high");
  });

  test("per-call reasoningEffort overrides config reasoningEffort for openai", () => {
    const b = body(
      { reasoning: "openai", reasoningEffort: "low" },
      { reasoningEffort: "high" }
    );

    expect(b.reasoning_effort).toBe("high");
  });

  test("per-call reasoningEffort falls back to config when unset", () => {
    const b = body({ reasoning: "deepseek", reasoningEffort: "medium" }, {});

    expect(b.reasoning_effort).toBe("medium");
  });

  test("provider without reasoningEffort support omits it (no-op)", () => {
    const b = body({ reasoning: "qwen" }, { reasoningEffort: "high" });

    expect(b.reasoning_effort).toBeUndefined();
  });

  test("none style omits reasoningEffort even when override is set", () => {
    const b = body(
      { reasoning: "none", reasoningEffort: "low" },
      { reasoningEffort: "high" }
    );

    expect(b.reasoning_effort).toBeUndefined();
  });
});

describe("buildRequestBody: no-tools call mode", () => {
  test("when tools are provided, they are sent normally", () => {
    const b = body({}, { tools: [{ name: "read", parameters: {} }] });

    expect(b.tools).toBeDefined();
    expect(Array.isArray(b.tools)).toBe(true);
    expect((b.tools as unknown[]).length).toBe(1);
  });

  test("toolChoice:none with tools still advertises tools (needed for explicit suppression)", () => {
    const b = body(
      {},
      {
        tools: [{ name: "read", parameters: {} }],
        toolChoice: "none",
      }
    );

    expect(b.tools).toBeDefined();
    expect(b.tool_choice).toBe("none");
  });

  test("when tools are undefined, no tools block is sent", () => {
    const b = body({}, { tools: undefined });

    expect(b.tools).toBeUndefined();
    expect(b.tool_choice).toBeUndefined();
  });

  test("empty tools array is OMITTED entirely (vLLM/DeepSeek 400 on `tools: []`)", () => {
    // Live regression: the real endpoint rejects `tools: []` ("must not be an empty
    // array … omit the field entirely"). The R1 no-tools diagnosis call passes [] to
    // force a tool-less turn — it must OMIT both `tools` and `tool_choice`, not send [].
    const b = body({}, { tools: [], toolChoice: "none" });

    expect(b.tools).toBeUndefined();
    expect(b.tool_choice).toBeUndefined();
  });
});

describe("buildRequestBody: per-call temperature override", () => {
  test("per-call temperature overrides config temperature for qwen", () => {
    const b = body({ reasoning: "qwen" }, { temperature: 0.9 });

    expect(b.temperature).toBe(0.9);
  });

  test("per-call temperature overrides config temperature for deepseek", () => {
    const b = body({ reasoning: "deepseek" }, { temperature: 0.7 });

    expect(b.temperature).toBe(0.7);
  });

  test("openai style omits temperature even when override is set", () => {
    const b = body({ reasoning: "openai" }, { temperature: 0.9 });

    expect(b.temperature).toBeUndefined();
  });

  test("per-call temperature no-ops cleanly when undefined", () => {
    const b = body({}, { temperature: undefined });

    expect(b.temperature).toBeUndefined();
  });
});
