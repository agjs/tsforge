import { test, expect } from "bun:test";
import { OpenAICompatibleProvider } from "../src/inference";

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();

      for (const c of chunks) {
        controller.enqueue(enc.encode(c));
      }

      controller.close();
    },
  });

  return new Response(stream, { status: 200 });
}

test("streams reasoning + content tokens and assembles tool calls", async () => {
  const chunks = [
    `data: {"choices":[{"delta":{"reasoning_content":"thinking…"}}]}\n`,
    `data: {"choices":[{"delta":{"content":"he"}}]}\n`,
    `data: {"choices":[{"delta":{"content":"llo"}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"edit","arguments":"{\\"file\\":\\"a"}}]}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".ts\\"}"}}]}}]}\n`,
    `data: [DONE]\n`,
  ];
  const fakeFetch = (async () =>
    sseResponse(chunks)) as unknown as typeof fetch;
  const tokens: string[] = [];
  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
  });

  const r = await p.complete([{ role: "user", content: "hi" }], {
    onToken: (t) => tokens.push(t),
  });

  const streamed = tokens.join("");

  // The log streams reasoning + content, plus a clean tool-name marker when a
  // tool call starts (so a long tool generation isn't silent) — but NOT the raw
  // tool-call JSON, which lands as a structured create/edit event elsewhere.
  expect(streamed).toContain("thinking…hello");
  expect(streamed).toContain("✎ edit");
  expect(streamed).not.toContain('"file"');
  expect(r.content).toBe("hello");
  expect(r.toolCalls).toEqual([{ name: "edit", arguments: { file: "a.ts" } }]);
});

test("surfaces live progress (path + size heartbeat) as a big create streams", async () => {
  const big = "x".repeat(4000); // > PROGRESS_EVERY (1500) → multiple heartbeats
  const chunks = [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"create","arguments":"{\\"file\\":\\"src/C.tsx\\",\\"content\\":\\""}}]}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"${big}"}}]}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]}}]}\n`,
    `data: [DONE]\n`,
  ];
  const fakeFetch = (async () =>
    sseResponse(chunks)) as unknown as typeof fetch;
  const tokens: string[] = [];
  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
  });

  await p.complete([{ role: "user", content: "hi" }], {
    onToken: (t) => tokens.push(t),
  });

  const streamed = tokens.join("");

  // The file path appears as soon as it's parseable, then a size heartbeat — so a
  // minutes-long generation is never silent. The raw arg JSON is still NOT dumped.
  expect(streamed).toContain("✎ → src/C.tsx");
  expect(streamed).toContain("KB streamed");
  expect(streamed).not.toContain('"content"');
});

test("sets stream:true in the request body when onToken is given", async () => {
  let body: Record<string, unknown> = {};
  const fakeFetch = (async (_url: string | URL, init: RequestInit) => {
    body = JSON.parse(String(init.body));

    return sseResponse([`data: [DONE]\n`]);
  }) as unknown as typeof fetch;
  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
  });

  await p.complete([{ role: "user", content: "hi" }], { onToken: () => {} });

  expect(body.stream).toBe(true);
  // Ask the server to emit token usage in the stream (basis for the context
  // gauge + auto-compaction).
  expect(body.stream_options).toEqual({ include_usage: true });
});

test("captures token usage from the trailing stream chunk", async () => {
  const chunks = [
    `data: {"choices":[{"delta":{"content":"hi"}}]}\n`,
    // vLLM/OpenAI emit a final chunk with empty choices carrying usage.
    `data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":34,"total_tokens":1234}}\n`,
    `data: [DONE]\n`,
  ];
  const fakeFetch = (async () =>
    sseResponse(chunks)) as unknown as typeof fetch;
  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
  });

  const r = await p.complete([{ role: "user", content: "hi" }], {
    onToken: () => {},
  });

  expect(r.usage).toEqual({
    promptTokens: 1200,
    completionTokens: 34,
    totalTokens: 1234,
  });
});

test("streams a final SSE line even when it has no trailing newline", async () => {
  const fakeFetch = (async () =>
    sseResponse([
      `data: {"choices":[{"delta":{"content":"tail"}}]}`,
    ])) as unknown as typeof fetch;
  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
  });

  const r = await p.complete([{ role: "user", content: "hi" }], {
    onToken: () => {},
  });

  expect(r.content).toBe("tail");
});

test("an error carried INSIDE a 200 stream is raised, not read as silence", async () => {
  // vLLM answers a rejected parameter with HTTP 200 and an error object in the
  // SSE body. Ignoring it produced an empty completion that read as "the model
  // chose to say nothing" — so the loop retried the same doomed request for its
  // whole turn budget and the task failed as if the model could not do the work.
  const chunks = [
    `data: {"error": {"message": "thinking_token_budget is not yet supported by the V2 model runner.", "type": "BadRequestError", "code": 400}}\n`,
    `data: [DONE]\n`,
  ];
  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: (async () => sseResponse(chunks)) as unknown as typeof fetch,
  });

  expect(
    p.complete([{ role: "user", content: "hi" }], { onToken: () => undefined })
  ).rejects.toThrow(/thinking_token_budget/u);
});

test("a rejected optional field is dropped and the call retried once", async () => {
  // Self-healing across runtime versions: the same harness has to work against
  // a vLLM that supports thinking_token_budget and one that does not.
  const bodies: string[] = [];
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    bodies.push(init.body);

    return bodies.length === 1
      ? sseResponse([
          `data: {"error": {"message": "thinking_token_budget is not yet supported by the V2 model runner.", "code": 400}}\n`,
          `data: [DONE]\n`,
        ])
      : sseResponse([
          `data: {"choices":[{"delta":{"content":"ok"}}]}\n`,
          `data: [DONE]\n`,
        ]);
  }) as unknown as typeof fetch;

  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
    reasoning: "deepseek-local",
  });

  const r = await p.complete([{ role: "user", content: "hi" }], {
    onToken: () => undefined,
    thinkingTokenBudget: 2048,
  });

  expect(r.content).toBe("ok");
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toContain("thinking_token_budget");
  expect(bodies[1]).not.toContain("thinking_token_budget");
});

test("a rejection that names nothing we sent is not retried", async () => {
  // Blind retry would hide real request errors. Only a 4xx naming an optional
  // field we actually sent earns a second attempt.
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;

    return sseResponse([
      `data: {"error": {"message": "context length exceeded", "code": 400}}\n`,
      `data: [DONE]\n`,
    ]);
  }) as unknown as typeof fetch;

  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
  });

  expect(
    p.complete([{ role: "user", content: "hi" }], {
      onToken: () => undefined,
      thinkingTokenBudget: 2048,
    })
  ).rejects.toThrow(/context length/u);
  expect(calls).toBe(1);
});
