import { reject, str, type IToolContext } from "./tool-context";

/** Default cap on returned content. Whole pages blow the context budget; the
 *  model can re-fetch with a higher `maxChars` when it genuinely needs more. */
export const WEB_FETCH_MAX_CHARS = 8000;

const MAX_ALLOWED_CHARS = WEB_FETCH_MAX_CHARS * 8;

/** Loopback / link-local / RFC-1918 hosts — blocked so a model-issued URL can't
 *  reach the host's cloud-metadata endpoint or poke internal services (SSRF). */
const PRIVATE_HOST_RE =
  /^(?:localhost|0\.0\.0\.0|127\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");

  return host === "::1" || PRIVATE_HOST_RE.test(host);
}

/** Parse + vet a fetch target: absolute http(s) only, public host only. Returns
 *  the URL or null (never throws) so the handler can reject cleanly. */
export function validateFetchUrl(raw: string): URL | null {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  if (isPrivateHost(url.hostname)) {
    return null;
  }

  return url;
}

export interface IFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface IWebFetchDeps {
  fetchFn: (url: string) => Promise<IFetchResponse>;
  /** HTML → readable markdown. Async: the real impl lazy-loads the extractor. */
  extract: (html: string, url: string) => Promise<string>;
}

function maxChars(args: Record<string, unknown>): number {
  const v = args.maxChars;

  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return Math.min(Math.floor(v), MAX_ALLOWED_CHARS);
  }

  return WEB_FETCH_MAX_CHARS;
}

function truncate(content: string, max: number): string {
  const trimmed = content.trim();

  if (trimmed.length <= max) {
    return trimmed;
  }

  const dropped = trimmed.length - max;

  return `${trimmed.slice(0, max)}\n\n…[truncated ${String(dropped)} chars — re-fetch with a higher maxChars to read more]`;
}

/**
 * `web_fetch` — retrieve a public web page and return its main content as
 * readable markdown. Fully local: one outbound GET, then the article text is
 * extracted on the user's own machine (no third-party API, no key). The URL is
 * vetted (http(s) + public host) before any network call.
 */
export async function doWebFetch(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: IWebFetchDeps = DEFAULT_DEPS
): Promise<string> {
  const url = validateFetchUrl(str(args, "url"));

  if (url === null) {
    return reject(
      ctx,
      "web_fetch",
      "web_fetch: `url` must be an absolute http(s) URL to a public host."
    );
  }

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `↳ web_fetch ${url.href}`,
  });

  let body: string;

  try {
    const res = await deps.fetchFn(url.href);

    if (!res.ok) {
      return `web_fetch: ${url.href} returned HTTP ${String(res.status)}.`;
    }

    body = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";

    return `web_fetch: failed to fetch ${url.href} — ${msg}`;
  }

  const content = await deps.extract(body, url.href);

  return truncate(content, maxChars(args));
}

async function realFetch(url: string): Promise<IFetchResponse> {
  return fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "tsforge-web-fetch/1.0 (+local)" },
  });
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Readable extraction via jsdom + Mozilla Readability + Turndown — all local,
 *  lazy-loaded so they cost nothing until a fetch actually runs. Falls back to a
 *  crude tag-strip if those libs are unavailable or parsing fails. */
async function realExtract(html: string, url: string): Promise<string> {
  try {
    const { JSDOM } = await import("jsdom");
    const { Readability } = await import("@mozilla/readability");
    const Turndown = (await import("turndown")).default;

    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    const content = article?.content ?? "";

    if (content.length === 0) {
      return stripTags(html);
    }

    const title = article?.title ?? "";
    const body = new Turndown().turndown(content);

    return title.length > 0 ? `# ${title}\n\n${body}` : body;
  } catch {
    return stripTags(html);
  }
}

const DEFAULT_DEPS: IWebFetchDeps = {
  fetchFn: realFetch,
  extract: realExtract,
};
