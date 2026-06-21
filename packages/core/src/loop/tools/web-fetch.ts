import { reject, str, type IToolContext } from "./tool-context";

/** Default cap on returned content. Whole pages blow the context budget; the
 *  model can re-fetch with a higher `maxChars` when it genuinely needs more. */
export const WEB_FETCH_MAX_CHARS = 8000;

const MAX_ALLOWED_CHARS = WEB_FETCH_MAX_CHARS * 8;

/** Loopback / link-local / RFC-1918 IPv4 (+ localhost) — blocked so a model-issued
 *  URL can't reach the host's cloud-metadata endpoint or poke internal services.
 *  Applied to BOTH literal URL hosts and DNS-resolved IPs (same classifier). */
const PRIVATE_HOST_RE =
  /^(?:localhost|0\.0\.0\.0|127\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();

  if (host === "::1" || host === "::" || PRIVATE_HOST_RE.test(host)) {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:…) — blocked wholesale. The URL parser canonicalizes
  // the embedded v4 to hex (::ffff:127.0.0.1 → ::ffff:7f00:1), so matching dotted
  // decimal is unreliable; mapped addresses have no legitimate web_fetch use and
  // are a known SSRF evasion, so reject the whole prefix.
  if (host.startsWith("::ffff:")) {
    return true;
  }

  // IPv6 unique-local (fc00::/7 → fc.. / fd..) and link-local (fe80::/10).
  return (
    /^f[cd][0-9a-f]{0,2}:/u.test(host) || /^fe[89ab][0-9a-f]?:/u.test(host)
  );
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

  let content: string;

  try {
    content = await deps.extract(body, url.href);
  } catch (err) {
    // Self-contained: an extractor throw must become a tool-error STRING, not
    // propagate into the loop (the outer dispatch boundary would catch it, but a
    // handler owning its own failure gives the model a precise, actionable message).
    const msg = err instanceof Error ? err.message : "unknown error";

    return `web_fetch: fetched ${url.href} but failed to extract readable content — ${msg}`;
  }

  return truncate(content, maxChars(args));
}

/** Max redirect hops followed before giving up. */
const MAX_REDIRECTS = 5;

const FETCH_HEADERS = { "user-agent": "tsforge-web-fetch/1.0 (+local)" };

/** A raw HTTP response with enough surface to follow redirects. `fetch`'s real
 *  Response satisfies this; tests inject a fake to exercise the redirect guard. */
export interface IRawResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type RawFetch = (
  url: string,
  init: { redirect: "manual"; headers: Record<string, string> }
) => Promise<IRawResponse>;

/** Resolve a hostname to its IP addresses. Injected so tests stay offline. */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

const realResolve: ResolveHost = async (hostname) => {
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(hostname, { all: true });

  return records.map((r) => r.address);
};

/**
 * Reject a host that RESOLVES to a private/loopback/link-local IP, even when the
 * hostname string looks public. Wildcard-DNS services (`127-0-0-1.sslip.io`,
 * `foo.127.0.0.1.nip.io`) defeat a string-only check; this resolves the name and
 * re-runs the SAME IP classifier on every returned address.
 *
 * Residual: DNS rebinding (TOCTOU between this lookup and undici's own connect)
 * is not fully closed without pinning the IP and connecting to it with a Host
 * header — out of scope here; this closes the wildcard-DNS / public-name class.
 */
async function assertPublicResolution(
  url: URL,
  resolve: ResolveHost
): Promise<void> {
  let addresses: readonly string[];

  try {
    addresses = await resolve(url.hostname);
  } catch {
    throw new Error(`could not resolve host (${url.hostname})`);
  }

  if (addresses.length === 0) {
    throw new Error(`host did not resolve (${url.hostname})`);
  }

  const priv = addresses.find((ip) => isPrivateHost(ip));

  if (priv !== undefined) {
    throw new Error(
      `blocked a host resolving to a private address (${url.hostname} → ${priv})`
    );
  }
}

/**
 * Follow redirects MANUALLY, re-validating EVERY hop's host. `redirect: "follow"`
 * is an SSRF hole: a public URL can 30x-redirect to localhost / the cloud-metadata
 * endpoint, which the one-time upfront host check never sees. Each Location is
 * vetted with `validateFetchUrl` (public http(s) host string) AND each hop's host
 * is DNS-resolved and re-checked against the private-IP classifier before we
 * connect — so a public-looking name resolving to a private IP is refused too.
 */
export async function fetchFollowingRedirects(
  start: string,
  rawFetch: RawFetch,
  resolve: ResolveHost = realResolve
): Promise<IFetchResponse> {
  let current = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicResolution(new URL(current), resolve);

    const res = await rawFetch(current, {
      redirect: "manual",
      headers: FETCH_HEADERS,
    });

    if (res.status < 300 || res.status >= 400) {
      return res;
    }

    const location = res.headers.get("location");

    if (location === null || location.length === 0) {
      return res;
    }

    const next = new URL(location, current);

    if (validateFetchUrl(next.href) === null) {
      throw new Error(
        `blocked a redirect to a non-public host (${next.hostname})`
      );
    }

    current = next.href;
  }

  throw new Error("too many redirects");
}

async function realFetch(url: string): Promise<IFetchResponse> {
  return fetchFollowingRedirects(url, (target, init) => fetch(target, init));
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
