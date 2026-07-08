import { test, expect } from "bun:test";
import { describeImage, DEFAULT_VISION_PROMPT } from "../src/inference/vision";
import type { IOpenAICompatibleConfig } from "../src/inference/inference.types";

const CFG: IOpenAICompatibleConfig = {
  baseUrl: "https://vlm.example/v1",
  model: "some-vlm",
  apiKey: "sk-test",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("describeImage posts a multimodal chat request and returns the text", async () => {
  let capturedUrl = "";
  let capturedBody: unknown;
  let capturedAuth: string | undefined;

  const fakeFetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedBody = JSON.parse(String(init?.body));
    capturedAuth = new Headers(init?.headers).get("authorization") ?? undefined;

    return jsonResponse({
      choices: [{ message: { content: "a red button" } }],
    });
  }) as unknown as typeof fetch;

  const text = await describeImage(
    CFG,
    {
      prompt: DEFAULT_VISION_PROMPT,
      images: [{ base64: "AAAA", mimeType: "image/png" }],
    },
    { fetch: fakeFetch }
  );

  expect(text).toBe("a red button");
  expect(capturedUrl).toBe("https://vlm.example/v1/chat/completions");
  expect(capturedAuth).toBe("Bearer sk-test");

  // The user message content is a multimodal array with the image as a data URI.
  const body = capturedBody as {
    model: string;
    messages: { role: string; content: unknown[] }[];
  };

  expect(body.model).toBe("some-vlm");
  const parts = body.messages[0]?.content as {
    type: string;
    image_url?: { url: string };
  }[];

  expect(parts[0]?.type).toBe("text");
  expect(parts[1]?.type).toBe("image_url");
  expect(parts[1]?.image_url?.url).toBe("data:image/png;base64,AAAA");
});

test("describeImage handles a content-part array response", async () => {
  const fakeFetch = (async () =>
    jsonResponse({
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "hello " },
              { type: "text", text: "world" },
            ],
          },
        },
      ],
    })) as unknown as typeof fetch;

  const text = await describeImage(
    CFG,
    { prompt: "q", images: [{ base64: "x", mimeType: "image/jpeg" }] },
    { fetch: fakeFetch }
  );

  expect(text).toBe("hello world");
});

test("describeImage throws with status + body head on a non-2xx", async () => {
  const fakeFetch = (async () =>
    new Response("model not found", {
      status: 404,
    })) as unknown as typeof fetch;

  await expect(
    describeImage(
      CFG,
      { prompt: "q", images: [{ base64: "x", mimeType: "image/png" }] },
      { fetch: fakeFetch }
    )
  ).rejects.toThrow(/vision request failed \(404\).*model not found/s);
});

test("describeImage rejects when no images are provided", async () => {
  await expect(describeImage(CFG, { prompt: "q", images: [] })).rejects.toThrow(
    /no images/
  );
});
