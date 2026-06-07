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
});
