import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IOpenAICompatibleConfig } from "./inference.types";
import type { ImageApi } from "../models-config";
import { PROVIDER_LIMITS } from "./inference.constants";
import { buildRequestHeaders, chatCompletionsUrl } from "./request";
import { fetchWithRetry } from "./transport";
import { isRecord } from "../lib/guards";

/**
 * Image generation as a side-channel capability (mirrors `vision.ts`): the
 * primary text-only model can't produce pixels, so a configured `imageGen`
 * backend does, and the harness saves the bytes + returns a path. One shared
 * `generateImage()` so both the `generate_image` tool and the (future) reserved
 * `kind: "generate"` agent seam call the same code.
 *
 * Two OpenAI-compatible wire shapes are supported, selected per entry:
 *  - `chat-modalities` (default, OpenRouter): POST `/chat/completions` with
 *    `modalities:["image","text"]`; images come back on the assistant message.
 *  - `images-generations` (OpenAI/xAI/DALL·E): POST `/images/generations` with a
 *    `prompt` and `response_format:"b64_json"`.
 */
export interface IGeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface IGenerateImageInput {
  prompt: string;
  /** Wire shape; defaults to `chat-modalities`. */
  api?: ImageApi;
  /** e.g. `1024x1024` — only honored by the `images-generations` shape. */
  size?: string;
  /** How many images to request (images-generations `n`; default 1). */
  n?: number;
}

export interface IGenerateImageOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

const MIME_EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** File extension for a mime type (defaults to png). */
export function extForMime(mimeType: string): string {
  return MIME_EXT[mimeType] ?? "png";
}

/** Generate one or more images. Throws (with status + body head) on a non-2xx or
 *  when the response carries no decodable image, so a caller surfaces a real
 *  error instead of writing an empty file. */
export async function generateImage(
  cfg: IOpenAICompatibleConfig,
  input: IGenerateImageInput,
  opts: IGenerateImageOptions = {}
): Promise<IGeneratedImage[]> {
  const api: ImageApi = input.api ?? "chat-modalities";
  const doFetch = opts.fetch ?? cfg.fetch ?? fetch;
  const url =
    api === "images-generations"
      ? imagesGenerationsUrl(cfg.baseUrl)
      : chatCompletionsUrl(cfg.baseUrl);
  const body =
    api === "images-generations"
      ? imagesBody(cfg, input)
      : chatBody(cfg, input);

  const res = await fetchWithRetry(
    doFetch,
    url,
    buildRequestHeaders(cfg),
    body,
    cfg.timeoutMs ?? PROVIDER_LIMITS.requestTimeoutMs,
    opts.signal,
    cfg.connectRetryMs
  );

  if (!res.ok) {
    const head = (await res.text()).slice(0, 500);

    throw new Error(
      `image-gen request failed (${String(res.status)}): ${head}`
    );
  }

  const payload: unknown = await res.json();
  const refs =
    api === "images-generations"
      ? imageRefsFromImagesApi(payload)
      : imageRefsFromChat(payload);

  if (refs.length === 0) {
    throw new Error("image-gen response: no image content");
  }

  return Promise.all(refs.map((ref) => resolveRef(ref, doFetch, opts.signal)));
}

/** Write generated images to `dir` (created if needed) as `<baseName>-<i>.<ext>`;
 *  returns the absolute paths. A single image drops the index suffix. */
export async function saveGeneratedImages(
  images: IGeneratedImage[],
  dir: string,
  baseName: string
): Promise<string[]> {
  await mkdir(dir, { recursive: true });

  return Promise.all(
    images.map(async (image, i) => {
      const ext = extForMime(image.mimeType);
      const name =
        images.length === 1
          ? `${baseName}.${ext}`
          : `${baseName}-${String(i)}.${ext}`;
      const path = join(dir, name);

      await writeFile(path, image.bytes);

      return path;
    })
  );
}

function chatBody(
  cfg: IOpenAICompatibleConfig,
  input: IGenerateImageInput
): string {
  return JSON.stringify({
    model: cfg.model,
    messages: [{ role: "user", content: input.prompt }],
    modalities: ["image", "text"],
    ...(cfg.extraBody ?? {}),
  });
}

function imagesBody(
  cfg: IOpenAICompatibleConfig,
  input: IGenerateImageInput
): string {
  return JSON.stringify({
    model: cfg.model,
    prompt: input.prompt,
    n: input.n ?? 1,
    response_format: "b64_json",
    ...(input.size === undefined ? {} : { size: input.size }),
    ...(cfg.extraBody ?? {}),
  });
}

function imagesGenerationsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");

  return trimmed.endsWith("/images/generations")
    ? trimmed
    : `${trimmed}/images/generations`;
}

/** An image reference extracted from a response: either an inline data URI /
 *  base64 payload, or an http(s) URL to fetch. */
type ImageRef =
  | { kind: "data"; base64: string; mimeType: string }
  | { kind: "url"; url: string };

/** OpenRouter-style: images ride on `choices[0].message.images[]` as
 *  `{ image_url: { url } }`; also tolerate content-part arrays. */
function imageRefsFromChat(payload: unknown): ImageRef[] {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return [];
  }

  const message: unknown = isRecord(payload.choices[0])
    ? payload.choices[0].message
    : undefined;

  if (!isRecord(message)) {
    return [];
  }

  const urls: string[] = [];

  const collect = (item: unknown): void => {
    const imageUrl: unknown = isRecord(item) ? item.image_url : undefined;
    const url: unknown = isRecord(imageUrl) ? imageUrl.url : undefined;

    if (typeof url === "string") {
      urls.push(url);
    }
  };

  if (Array.isArray(message.images)) {
    message.images.forEach(collect);
  }

  if (Array.isArray(message.content)) {
    message.content.forEach(collect);
  }

  return urls.map(refFromUrl);
}

/** OpenAI `/images/generations`: `data[]` with `b64_json` or `url`. */
function imageRefsFromImagesApi(payload: unknown): ImageRef[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return [];
  }

  const refs: ImageRef[] = [];

  for (const item of payload.data) {
    if (!isRecord(item)) {
      continue;
    }

    if (typeof item.b64_json === "string") {
      refs.push({ kind: "data", base64: item.b64_json, mimeType: "image/png" });
    } else if (typeof item.url === "string") {
      refs.push(refFromUrl(item.url));
    }
  }

  return refs;
}

/** Classify a url as an inline data URI (decode locally) vs a remote url (fetch). */
function refFromUrl(url: string): ImageRef {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);

  return match?.[1] !== undefined && match[2] !== undefined
    ? { kind: "data", base64: match[2], mimeType: match[1] }
    : { kind: "url", url };
}

async function resolveRef(
  ref: ImageRef,
  doFetch: typeof fetch,
  signal?: AbortSignal
): Promise<IGeneratedImage> {
  if (ref.kind === "data") {
    return {
      bytes: new Uint8Array(Buffer.from(ref.base64, "base64")),
      mimeType: ref.mimeType,
    };
  }

  // The provider hands back a URL we then fetch — untrusted, so restrict to
  // http(s). Reject file:/data:/gopher:/etc. so a malicious/compromised endpoint
  // can't point us at localhost, cloud-metadata IPs, or a local file.
  let scheme: string;

  try {
    scheme = new URL(ref.url).protocol;
  } catch {
    throw new Error(`image-gen: refusing to fetch a malformed image url`);
  }

  if (scheme !== "http:" && scheme !== "https:") {
    throw new Error(`image-gen: refusing non-http(s) image url (${scheme})`);
  }

  const res = await doFetch(ref.url, { signal });

  if (!res.ok) {
    throw new Error(
      `image-gen: fetching image url failed (${String(res.status)})`
    );
  }

  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    mimeType: res.headers.get("content-type") ?? "image/png",
  };
}
