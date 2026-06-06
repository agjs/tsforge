import { expect, test } from "bun:test";
import { OpenAICompatibleProvider } from "../src/inference/openai-compatible";

function okResponse(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    { status: 200 }
  );
}

test("retries a transient connection blip, then succeeds", async () => {
  let calls = 0;
  const flakyFetch = (async () => {
    calls += 1;

    if (calls === 1) {
      throw new Error(
        "Unable to connect. Is the computer able to access the url?"
      );
    }

    return okResponse();
  }) as unknown as typeof fetch;

  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: flakyFetch,
  });
  const r = await p.complete([{ role: "user", content: "hi" }], {});

  expect(calls).toBe(2); // first threw, retry succeeded
  expect(r.content).toBe("ok");
});

test("does NOT retry a non-connection error (propagates)", async () => {
  let calls = 0;
  const badFetch = (async () => {
    calls += 1;

    throw new Error("something unrelated");
  }) as unknown as typeof fetch;

  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: badFetch,
  });

  await expect(
    p.complete([{ role: "user", content: "hi" }], {})
  ).rejects.toThrow("something unrelated");
  expect(calls).toBe(1); // no retry on a non-transient error
});

test("posts to /chat/completions and parses content + tool calls", async () => {
  let captured: { url: string; body: Record<string, unknown> } | null = null;
  const fakeFetch = (async (url: string | URL, init: RequestInit) => {
    captured = { url: String(url), body: JSON.parse(String(init.body)) };
    const payload = {
      choices: [
        {
          message: {
            content: "ok",
            tool_calls: [
              { function: { name: "edit", arguments: '{"file":"a.ts"}' } },
            ],
          },
        },
      ],
    };

    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;

  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "qwen3.6-27b",
    apiKey: "k",
    fetch: fakeFetch,
  });

  const r = await p.complete([{ role: "user", content: "hi" }], {
    temperature: 0,
  });

  expect(captured!.url).toBe("http://x/v1/chat/completions");
  expect(captured!.body.model).toBe("qwen3.6-27b");
  expect(captured!.body.messages).toEqual([{ role: "user", content: "hi" }]);
  expect(r.content).toBe("ok");
  expect(r.toolCalls).toEqual([{ name: "edit", arguments: { file: "a.ts" } }]);
});

test("attaches an abort signal so a hung request can't block forever", async () => {
  let signal: AbortSignal | null | undefined;
  const fakeFetch = (async (_url: string | URL, init: RequestInit) => {
    signal = init.signal;

    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
    timeoutMs: 1000,
  });

  await p.complete([{ role: "user", content: "hi" }]);

  expect(signal).toBeInstanceOf(AbortSignal);
});

test("serializes assistant tool_calls + tool-result messages to wire format", async () => {
  let body: { messages: Record<string, unknown>[] } = { messages: [] };
  const fakeFetch = (async (_url: string | URL, init: RequestInit) => {
    body = JSON.parse(String(init.body));

    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
  });

  await p.complete([
    { role: "user", content: "do it" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "run", arguments: { command: "ls" } }],
    },
    { role: "tool", content: "a.ts", toolCallId: "call_1" },
  ]);

  expect(body.messages[1]).toEqual({
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "run", arguments: '{"command":"ls"}' },
      },
    ],
  });
  expect(body.messages[2]).toEqual({
    role: "tool",
    tool_call_id: "call_1",
    content: "a.ts",
  });
});

test("sends thinking_token_budget to cap reasoning when set", async () => {
  let body: Record<string, unknown> = {};
  const fakeFetch = (async (_url: string | URL, init: RequestInit) => {
    body = JSON.parse(String(init.body));

    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
  });

  await p.complete([{ role: "user", content: "hi" }], {
    thinkingTokenBudget: 256,
  });

  expect(body.thinking_token_budget).toBe(256);
});

test("parses the tool-call id from the model response", async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                { id: "abc", function: { name: "run", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
  });
  const r = await p.complete([{ role: "user", content: "x" }]);

  expect(r.toolCalls[0]?.id).toBe("abc");
});

test("sends repetition_penalty when configured, to break degenerate loops", async () => {
  let body: Record<string, unknown> = {};
  const fakeFetch = (async (_url: string | URL, init: RequestInit) => {
    body = JSON.parse(String(init.body));

    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
    repetitionPenalty: 1.1,
  });

  await p.complete([{ role: "user", content: "hi" }]);

  expect(body.repetition_penalty).toBe(1.1);
});

test("caps response tokens so a runaway generation can't spew forever", async () => {
  let body: Record<string, unknown> = {};
  const fakeFetch = (async (_url: string | URL, init: RequestInit) => {
    body = JSON.parse(String(init.body));

    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
    maxTokens: 4096,
  });

  await p.complete([{ role: "user", content: "hi" }]);

  expect(body.max_tokens).toBe(4096);
});

test("sends tool_choice 'required' when asked, to force a tool call", async () => {
  let body: Record<string, unknown> = {};
  const fakeFetch = (async (_url: string | URL, init: RequestInit) => {
    body = JSON.parse(String(init.body));

    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
  });

  await p.complete([{ role: "user", content: "hi" }], {
    tools: [{ type: "function" }],
    toolChoice: "required",
  });

  expect(body.tool_choice).toBe("required");
});

test("throws on a non-200 response", async () => {
  const fakeFetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
  });

  await expect(p.complete([{ role: "user", content: "hi" }])).rejects.toThrow(
    "500"
  );
});

test("includes tools + tool_choice in the body when provided", async () => {
  let body: Record<string, unknown> = {};
  const fakeFetch = (async (_url: string | URL, init: RequestInit) => {
    body = JSON.parse(String(init.body));

    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const p = new OpenAICompatibleProvider({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: fakeFetch,
  });

  await p.complete([{ role: "user", content: "hi" }], {
    tools: [{ type: "function" }],
  });

  expect(Array.isArray(body.tools)).toBe(true);
  expect(body.tool_choice).toBe("auto");
});
