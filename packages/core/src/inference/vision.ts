import type { IOpenAICompatibleConfig } from "./inference.types";
import { PROVIDER_LIMITS } from "./inference.constants";
import { buildRequestHeaders, chatCompletionsUrl } from "./request";
import { fetchWithRetry } from "./transport";
import { isRecord } from "../lib/guards";

/**
 * Vision (image reading) as a SIDE-CHANNEL call, deliberately separate from the
 * main `IChatMessage` pipeline. The primary chat model is text-only and can't
 * ingest an image, so the harness asks a configured vision backend to describe
 * the image and feeds only the resulting TEXT back into the conversation. Keeping
 * this self-contained means the core message type stays `content: string` and the
 * whole feature is off unless a `vision` capability is configured.
 *
 * The request is a one-shot OpenAI-compatible `/chat/completions` whose single
 * user message carries a multimodal content array (`text` + `image_url` data
 * URIs) — the shape every OpenAI-compatible vision endpoint (OpenRouter, a local
 * vLLM VLM, ...) accepts. Header/URL/transport logic is reused from the request
 * layer so retries and auth behave identically to a normal chat call.
 */
export interface IImageInput {
  /** Base64 (no data-URI prefix) of the image bytes. */
  base64: string;
  /** e.g. `image/png`, `image/jpeg`, `image/webp`, `image/gif`. */
  mimeType: string;
}

export interface IDescribeImageInput {
  /** The question / instruction for the vision model about the image(s). */
  prompt: string;
  images: IImageInput[];
}

export interface IDescribeImageOptions {
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the config's fetch or global fetch. */
  fetch?: typeof fetch;
}

/** A default instruction used when the caller has no specific question — biased
 *  toward what a coding agent needs out of a screenshot/mockup. */
export const DEFAULT_VISION_PROMPT =
  "Describe this image in detail for a software engineer. Transcribe any visible " +
  "text, code, UI, errors, or diagrams exactly.";

function dataUri(image: IImageInput): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}

/** Ask the vision backend to describe/answer about one or more images; returns
 *  the model's text. Throws on a non-2xx response (with the status + body head)
 *  so the caller can surface an actionable tool error rather than a silent "". */
export async function describeImage(
  cfg: IOpenAICompatibleConfig,
  input: IDescribeImageInput,
  opts: IDescribeImageOptions = {}
): Promise<string> {
  if (input.images.length === 0) {
    throw new Error("describeImage: no images provided");
  }

  const content = [
    { type: "text", text: input.prompt },
    ...input.images.map((image) => ({
      type: "image_url",
      image_url: { url: dataUri(image) },
    })),
  ];

  const body = JSON.stringify({
    model: cfg.model,
    messages: [{ role: "user", content }],
    max_tokens:
      cfg.maxTokens !== undefined && Number.isFinite(cfg.maxTokens)
        ? cfg.maxTokens
        : PROVIDER_LIMITS.maxTokens,
    ...(cfg.extraBody ?? {}),
  });

  const doFetch = opts.fetch ?? cfg.fetch ?? fetch;
  const res = await fetchWithRetry(
    doFetch,
    chatCompletionsUrl(cfg.baseUrl),
    buildRequestHeaders(cfg),
    body,
    cfg.timeoutMs ?? PROVIDER_LIMITS.requestTimeoutMs,
    opts.signal,
    cfg.connectRetryMs
  );

  if (!res.ok) {
    const head = (await res.text()).slice(0, 500);

    throw new Error(`vision request failed (${String(res.status)}): ${head}`);
  }

  return extractContent(await res.json());
}

/** Pull `choices[0].message.content` out of an OpenAI-compatible response. Some
 *  vision endpoints return `content` as a content-part array rather than a plain
 *  string, so handle both. */
function extractContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error("vision response: missing choices");
  }

  const first: unknown = payload.choices[0];
  const message: unknown = isRecord(first) ? first.message : undefined;
  const content: unknown = isRecord(message) ? message.content : undefined;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && typeof part.text === "string" ? part.text : ""
      )
      .join("");
  }

  throw new Error("vision response: no text content");
}
