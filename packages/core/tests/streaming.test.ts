import { test, expect } from "bun:test";
import { streamResponse } from "../src/inference/stream";
import { parseResponse } from "../src/inference/wire";
import { OpenAICompatibleProvider } from "../src/inference";
import { fetchReturning } from "./stub-provider";

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
  expect(streamed).toContain("✎ edit"); // edit keeps the pencil glyph
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
  expect(streamed).toContain("✚ → src/C.tsx");
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

test("an endpoint's rejection is remembered — the next call does not ask again", async () => {
  // Retrying per call fixed each call and still sent a request the server
  // refuses, forever: measured on a live box at ~305 wasted round trips an
  // hour, every one an error in the server's own log for a bug already handled.
  const bodies: string[] = [];
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    bodies.push(init.body);

    return init.body.includes("thinking_token_budget")
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
  const call = async (): Promise<string> =>
    (
      await p.complete([{ role: "user", content: "hi" }], {
        onToken: () => undefined,
        thinkingTokenBudget: 2048,
      })
    ).content;

  expect(await call()).toBe("ok");
  expect(await call()).toBe("ok");
  expect(await call()).toBe("ok");

  // One probe, then never again — 4 requests for 3 calls, not 6.
  expect(bodies).toHaveLength(4);
  expect(
    bodies.filter((b) => b.includes("thinking_token_budget"))
  ).toHaveLength(1);
});

test("switching endpoints forgets what the old one refused", async () => {
  // What one server rejects says nothing about the next; a stale memory would
  // silently drop a field the new endpoint supports.
  const bodies: string[] = [];
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    bodies.push(init.body);

    return init.body.includes("thinking_token_budget")
      ? sseResponse([
          `data: {"error": {"message": "thinking_token_budget is not supported", "code": 400}}\n`,
          `data: [DONE]\n`,
        ])
      : sseResponse([
          `data: {"choices":[{"delta":{"content":"ok"}}]}\n`,
          `data: [DONE]\n`,
        ]);
  }) as unknown as typeof fetch;

  const cfg = {
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
    reasoning: "deepseek-local" as const,
  };
  const p = new OpenAICompatibleProvider(cfg);
  const opts = { onToken: () => undefined, thinkingTokenBudget: 2048 };

  await p.complete([{ role: "user", content: "hi" }], opts);
  p.reconfigure({ ...cfg, baseUrl: "http://y/v1" });
  await p.complete([{ role: "user", content: "hi" }], opts);

  // Probed again after the swap, rather than assuming the new endpoint is the
  // same as the old one.
  expect(
    bodies.filter((b) => b.includes("thinking_token_budget"))
  ).toHaveLength(2);
});

test("carries prefix-cache hits through the STREAMING path", async () => {
  // The path that matters: run.ts sets `onToken` unconditionally, so every
  // build-loop call streams. Parsing that only worked non-streaming would leave
  // the long builds — the whole reason to watch the cache — unmeasured.
  const chunks = [
    `data: {"choices":[{"delta":{"content":"ok"}}]}\n`,
    `data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":10,"total_tokens":1010,"prompt_tokens_details":{"cached_tokens":900}}}\n`,
    `data: [DONE]\n`,
  ];
  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fetchReturning(() => sseResponse(chunks)),
  });

  const r = await p.complete([{ role: "user", content: "hi" }], {
    onToken: () => undefined,
  });

  expect(r.usage?.promptTokens).toBe(1000);
  expect(r.usage?.cachedPromptTokens).toBe(900);
});

test("streaming: DeepSeek's top-level cache spelling is read too", async () => {
  const chunks = [
    `data: {"choices":[{"delta":{"content":"ok"}}]}\n`,
    `data: {"choices":[],"usage":{"prompt_tokens":800,"completion_tokens":5,"total_tokens":805,"prompt_cache_hit_tokens":512}}\n`,
    `data: [DONE]\n`,
  ];
  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fetchReturning(() => sseResponse(chunks)),
  });

  const r = await p.complete([{ role: "user", content: "hi" }], {
    onToken: () => undefined,
  });

  expect(r.usage?.cachedPromptTokens).toBe(512);
});

test("streaming: a silent server leaves the cache field absent", async () => {
  const chunks = [
    `data: {"choices":[{"delta":{"content":"ok"}}]}\n`,
    `data: {"choices":[],"usage":{"prompt_tokens":800,"completion_tokens":5,"total_tokens":805}}\n`,
    `data: [DONE]\n`,
  ];
  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fetchReturning(() => sseResponse(chunks)),
  });

  const r = await p.complete([{ role: "user", content: "hi" }], {
    onToken: () => undefined,
  });

  expect(r.usage?.promptTokens).toBe(800);
  expect(r.usage?.cachedPromptTokens).toBeUndefined();
});

test("tool-args TTSR gets the latched file path on LATE deltas without rescanning", async () => {
  // Three deltas: path in the first, big body, closing quote. The path must be
  // latched once and still reach the watcher on the last delta — the old code
  // re-ran the extraction regex over the WHOLE accumulated args per delta
  // (O(n²) across a large file write).
  const seen: { text: string; currentFile?: string }[] = [];
  const watcher = {
    checkDelta(
      text: string,
      context: { source: "content" | "tool-args"; currentFile?: string }
    ): { readonly name: string; readonly guidance: string } | null {
      if (context.source === "tool-args") {
        seen.push(
          context.currentFile === undefined
            ? { text }
            : { text, currentFile: context.currentFile }
        );
      }

      return null;
    },
  };
  const big = "y".repeat(4000);
  const chunks = [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"create","arguments":"{\\"file\\":\\"src/latched.ts\\",\\"content\\":\\""}}]}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"${big}"}}]}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]}}]}\n`,
    `data: [DONE]\n`,
  ];
  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fetchReturning(() => sseResponse(chunks)),
  });

  await p.complete([{ role: "user", content: "hi" }], {
    onToken: () => undefined,
    ttsrManager: watcher,
  });

  expect(seen.length).toBe(3);
  // The path is known from delta 1 and carried to every later delta.
  expect(seen.every((s) => s.currentFile === "src/latched.ts")).toBe(true);
  // Each delta feeds only ITS OWN fragment to the watcher, never the
  // accumulated args (the watcher keeps its own rolling buffer).
  expect(seen[1]?.text.length).toBe(4000);
});

// ── I1: tool-call assembly correctness ─────────────────────────────────────

test("missing-index deltas with distinct ids stay TWO calls with intact args", async () => {
  // Mistral-compat / some llama.cpp builds omit `index` — everything used to
  // collapse into slot 0 with concatenated args that parsed to {} silently.
  const chunks = [
    `data: {"choices":[{"delta":{"tool_calls":[{"id":"call_a","type":"function","function":{"name":"create","arguments":""}}]}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"file\\":\\"a.ts\\"}"}}]}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"id":"call_b","type":"function","function":{"name":"create","arguments":""}}]}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"file\\":\\"b.ts\\"}"}}]}}]}\n`,
    `data: [DONE]\n`,
  ];
  const tokens: string[] = [];
  const res = await streamResponse(sseResponse(chunks), (t) => tokens.push(t));

  expect(res.toolCalls).toHaveLength(2);
  expect(res.toolCalls[0]?.arguments).toEqual({ file: "a.ts" });
  expect(res.toolCalls[1]?.arguments).toEqual({ file: "b.ts" });
  // The degraded shape is visible in the log exactly once.
  expect(tokens.filter((t) => t.includes("missing index")).length).toBe(1);
});

test("missing-index: a name after the current call's args began starts a NEW call", async () => {
  const chunks = [
    `data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"read","arguments":"{\\"file\\":\\"x.ts\\"}"}}]}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"read","arguments":"{\\"file\\":\\"y.ts\\"}"}}]}}]}\n`,
    `data: [DONE]\n`,
  ];
  const res = await streamResponse(sseResponse(chunks), () => {});

  expect(res.toolCalls).toHaveLength(2);
  expect(res.toolCalls[0]?.arguments).toEqual({ file: "x.ts" });
  expect(res.toolCalls[1]?.arguments).toEqual({ file: "y.ts" });
});

test("out-of-order indices emit in INDEX order, not arrival order", async () => {
  const chunks = [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","type":"function","function":{"name":"edit","arguments":"{\\"file\\":\\"second.ts\\"}"}}]}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"edit","arguments":"{\\"file\\":\\"first.ts\\"}"}}]}}]}\n`,
    `data: [DONE]\n`,
  ];
  const res = await streamResponse(sseResponse(chunks), () => {});

  expect(res.toolCalls.map((c) => c.arguments.file)).toEqual([
    "first.ts",
    "second.ts",
  ]);
});

test("an id-less split name assembles by APPEND; a re-declared name with id replaces", async () => {
  const split = [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"cre","arguments":""}}]}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"ate","arguments":"{\\"file\\":\\"a.ts\\",\\"content\\":\\"x\\"}"}}]}}]}\n`,
    `data: [DONE]\n`,
  ];
  const r1 = await streamResponse(sseResponse(split), () => {});

  // Old behavior overwrote → name "ate" → unknown-tool denial loop.
  expect(r1.toolCalls[0]?.name).toBe("create");

  const redeclared = [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":""}}]}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search","arguments":"{\\"query\\":\\"q\\"}"}}]}}]}\n`,
    `data: [DONE]\n`,
  ];
  const r2 = await streamResponse(sseResponse(redeclared), () => {});

  expect(r2.toolCalls[0]?.name).toBe("search");
});

// ── I2: finish_reason, truncation, parity, big-first-delta path latch ───────

test("finish_reason is surfaced on the streamed response", async () => {
  const chunks = [
    `data: {"choices":[{"delta":{"content":"hi"}}]}\n`,
    `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n`,
    `data: [DONE]\n`,
  ];
  const res = await streamResponse(sseResponse(chunks), () => {});

  expect(res.finishReason).toBe("stop");
});

test("length-truncated tool args are DROPPED with truncated:true (not executed as {})", async () => {
  // A create cut off at max_tokens mid-JSON: the old behavior parsed the
  // broken args to {} and executed create with no file/content → reject loop.
  const chunks = [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"create","arguments":"{\\"file\\":\\"a.ts\\",\\"content\\":\\"const x ="}}]}}]}\n`,
    `data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n`,
    `data: [DONE]\n`,
  ];
  const res = await streamResponse(sseResponse(chunks), () => {});

  expect(res.truncated).toBe(true);
  expect(res.finishReason).toBe("length");
  expect(res.toolCalls).toHaveLength(0);
});

test("unparseable args WITHOUT length keep the old {} degradation (no behavior change)", async () => {
  const chunks = [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"{broken"}}]}}]}\n`,
    `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n`,
    `data: [DONE]\n`,
  ];
  const res = await streamResponse(sseResponse(chunks), () => {});

  expect(res.truncated).toBeUndefined();
  expect(res.toolCalls).toHaveLength(1);
  expect(res.toolCalls[0]?.arguments).toEqual({});
});

test("streaming and non-streaming agree on the same logical payload (parity)", async () => {
  const streamed = await streamResponse(
    sseResponse([
      `data: {"choices":[{"delta":{"reasoning":"thinking"}}]}\n`,
      `data: {"choices":[{"delta":{"content":"answer"}}]}\n`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n`,
      `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n`,
      `data: [DONE]\n`,
    ]),
    () => {}
  );
  const nonStreamed = parseResponse({
    choices: [
      {
        finish_reason: "stop",
        // vLLM spells it `reasoning` — the non-streaming path used to read
        // ONLY `reasoning_content` and silently dropped the chain-of-thought.
        message: { content: "answer", reasoning: "thinking" },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

  expect(nonStreamed.content).toBe(streamed.content);
  expect(nonStreamed.reasoning).toBe(streamed.reasoning);
  expect(nonStreamed.finishReason).toBe(streamed.finishReason);
  expect(nonStreamed.usage?.totalTokens).toBe(streamed.usage?.totalTokens);
});

test("path-in-one-big-delta: file-scoped TTSR still gets currentFile (the perf-latch regression)", async () => {
  // The whole 3KB args arrive in ONE SSE frame — past MAX_PATH_SCAN_CHARS on
  // the first check. The old guard SKIPPED the scan entirely, so extractedPath
  // was never set and file-scoped TTSR rules silently never fired.
  const seen: { currentFile?: string }[] = [];
  const watcher = {
    checkDelta(
      _text: string,
      context: { source: "content" | "tool-args"; currentFile?: string }
    ): { readonly name: string; readonly guidance: string } | null {
      if (context.source === "tool-args") {
        seen.push(
          context.currentFile === undefined
            ? {}
            : { currentFile: context.currentFile }
        );
      }

      return null;
    },
  };
  const body = "z".repeat(3000);
  const chunks = [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"create","arguments":"{\\"file\\":\\"src/big.ts\\",\\"content\\":\\"${body}\\"}"}}]}}]}\n`,
    `data: [DONE]\n`,
  ];

  await streamResponse(sseResponse(chunks), () => {}, watcher);

  expect(seen.length).toBe(1);
  expect(seen[0]?.currentFile).toBe("src/big.ts");
});
