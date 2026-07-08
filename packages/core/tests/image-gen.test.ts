import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateImage,
  saveGeneratedImages,
  extForMime,
} from "../src/inference/image-gen";
import type { IOpenAICompatibleConfig } from "../src/inference/inference.types";

const CFG: IOpenAICompatibleConfig = {
  baseUrl: "https://img.example/v1",
  model: "flux",
  apiKey: "sk-test",
};

// one-pixel PNG bytes, base64-encoded
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("chat-modalities: posts modalities + decodes data-URI image from message.images", async () => {
  let capturedUrl = "";
  let capturedBody: unknown;

  const fakeFetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedBody = JSON.parse(String(init?.body));

    return jsonResponse({
      choices: [
        {
          message: {
            images: [
              { image_url: { url: `data:image/png;base64,${PNG_B64}` } },
            ],
          },
        },
      ],
    });
  }) as unknown as typeof fetch;

  const images = await generateImage(
    CFG,
    { prompt: "a cat" },
    { fetch: fakeFetch }
  );

  expect(capturedUrl).toBe("https://img.example/v1/chat/completions");
  expect((capturedBody as { modalities: string[] }).modalities).toEqual([
    "image",
    "text",
  ]);
  expect(images).toHaveLength(1);
  expect(images[0]?.mimeType).toBe("image/png");
  // decoded bytes are a real PNG (starts with the PNG magic number)
  expect(Array.from(images[0]!.bytes.subarray(0, 4))).toEqual([
    137, 80, 78, 71,
  ]);
});

test("images-generations: posts prompt/b64_json and decodes data[].b64_json", async () => {
  let capturedUrl = "";
  let capturedBody: unknown;

  const fakeFetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedBody = JSON.parse(String(init?.body));

    return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
  }) as unknown as typeof fetch;

  const images = await generateImage(
    CFG,
    { prompt: "a dog", api: "images-generations", size: "512x512" },
    { fetch: fakeFetch }
  );

  expect(capturedUrl).toBe("https://img.example/v1/images/generations");
  const body = capturedBody as {
    prompt: string;
    size: string;
    response_format: string;
  };

  expect(body.prompt).toBe("a dog");
  expect(body.size).toBe("512x512");
  expect(body.response_format).toBe("b64_json");
  expect(images).toHaveLength(1);
});

test("generateImage fetches a remote url when the response is not inline", async () => {
  const fakeFetch = (async (url: string) => {
    if (url.endsWith("/chat/completions")) {
      return jsonResponse({
        choices: [
          {
            message: {
              images: [{ image_url: { url: "https://cdn.example/x.png" } }],
            },
          },
        ],
      });
    }

    // the follow-up fetch of the remote image
    return new Response(Buffer.from(PNG_B64, "base64"), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }) as unknown as typeof fetch;

  const images = await generateImage(
    CFG,
    { prompt: "x" },
    { fetch: fakeFetch }
  );

  expect(images).toHaveLength(1);
  expect(Array.from(images[0]!.bytes.subarray(0, 4))).toEqual([
    137, 80, 78, 71,
  ]);
});

test("generateImage refuses a non-http(s) image url (SSRF guard)", async () => {
  const fakeFetch = (async () =>
    jsonResponse({
      choices: [
        { message: { images: [{ image_url: { url: "file:///etc/passwd" } }] } },
      ],
    })) as unknown as typeof fetch;

  await expect(
    generateImage(CFG, { prompt: "x" }, { fetch: fakeFetch })
  ).rejects.toThrow(/non-http\(s\)/);
});

test("generateImage throws on non-2xx and on an image-less response", async () => {
  const errFetch = (async () =>
    new Response("bad model", { status: 400 })) as unknown as typeof fetch;

  await expect(
    generateImage(CFG, { prompt: "x" }, { fetch: errFetch })
  ).rejects.toThrow(/image-gen request failed \(400\).*bad model/s);

  // A 2xx with a text reply and no image = a content-policy DECLINE — surface the
  // model's actual words so the caller relays the real reason, not "no image".
  const declineFetch = (async () =>
    jsonResponse({
      choices: [
        {
          message: {
            content: "I can't create images of copyrighted characters.",
          },
        },
      ],
    })) as unknown as typeof fetch;

  await expect(
    generateImage(CFG, { prompt: "x" }, { fetch: declineFetch })
  ).rejects.toThrow(/declined: .*copyrighted characters/s);

  // The real Gemini shape: finish_reason content_filter, everything else null →
  // a concrete "content filter" cause, not a vague "no image".
  const filterFetch = (async () =>
    jsonResponse({
      choices: [
        {
          finish_reason: "content_filter",
          message: { content: null, refusal: null },
        },
      ],
    })) as unknown as typeof fetch;

  await expect(
    generateImage(CFG, { prompt: "homer" }, { fetch: filterFetch })
  ).rejects.toThrow(/content filter/);
});

test("saveGeneratedImages writes files and returns paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-img-"));

  try {
    const bytes = new Uint8Array(Buffer.from(PNG_B64, "base64"));
    const paths = await saveGeneratedImages(
      [{ bytes, mimeType: "image/png" }],
      dir,
      "gen"
    );

    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(join(dir, "gen.png"));
    const onDisk = await readFile(paths[0]!);

    expect(Array.from(onDisk.subarray(0, 4))).toEqual([137, 80, 78, 71]);

    // multiple images get an index suffix
    const multi = await saveGeneratedImages(
      [
        { bytes, mimeType: "image/png" },
        { bytes, mimeType: "image/jpeg" },
      ],
      dir,
      "multi"
    );

    expect(multi[0]).toBe(join(dir, "multi-0.png"));
    expect(multi[1]).toBe(join(dir, "multi-1.jpg"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extForMime maps known types, defaults to png", () => {
  expect(extForMime("image/jpeg")).toBe("jpg");
  expect(extForMime("image/webp")).toBe("webp");
  expect(extForMime("application/octet-stream")).toBe("png");
});
