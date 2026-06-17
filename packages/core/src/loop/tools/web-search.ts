import { isRecord, isArray } from "../../lib/guards";
import { reject, str, type IToolContext } from "./tool-context";

/** DuckDuckGo's no-JS HTML endpoint — free, keyless, and returns plain markup we
 *  can parse. The default backend so web search works out of the box with zero
 *  setup. Users who want full privacy/control can point at a self-hosted SearXNG
 *  via TSFORGE_SEARXNG_URL instead. */
const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";

const MAX_RESULTS = 8;

export interface ISearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ISearchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface IWebSearchDeps {
  fetchFn: (url: string) => Promise<ISearchResponse>;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** DuckDuckGo wraps result links in a `/l/?uddg=<encoded-url>` redirect; unwrap
 *  it back to the real destination. Protocol-relative `//host` becomes https. */
function decodeDdgHref(href: string): string {
  const enc = /[?&]uddg=([^&]+)/.exec(href)?.[1];

  if (enc !== undefined) {
    try {
      return decodeURIComponent(enc);
    } catch {
      return href;
    }
  }

  return href.startsWith("//") ? `https:${href}` : href;
}

const ANCHOR_RE = /<a\b[^>]*class="result__a"[^>]*>[\s\S]*?<\/a>/g;
const SNIPPET_RE = /<a\b[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
const HREF_RE = /href="([^"]*)"/;
const INNER_RE = /<a\b[^>]*>([\s\S]*?)<\/a>/;

/** Extract results from DuckDuckGo HTML. Pure + synchronous so it's trivially
 *  testable against a captured markup fixture (no network). */
export function parseDuckDuckGoResults(html: string): ISearchResult[] {
  const snippets = [...html.matchAll(SNIPPET_RE)].map((m) =>
    stripHtml(m[1] ?? "")
  );
  const results: ISearchResult[] = [];
  let i = 0;

  for (const m of html.matchAll(ANCHOR_RE)) {
    const hrefV = HREF_RE.exec(m[0])?.[1];
    const innerV = INNER_RE.exec(m[0])?.[1];

    if (hrefV !== undefined && innerV !== undefined) {
      results.push({
        title: stripHtml(innerV),
        url: decodeDdgHref(hrefV),
        snippet: snippets[i] ?? "",
      });
    }

    i++;
  }

  return results;
}

/** Extract results from a SearXNG `format=json` response (untyped → narrowed). */
export function parseSearxngResults(json: unknown): ISearchResult[] {
  if (!isRecord(json) || !isArray(json.results)) {
    return [];
  }

  const out: ISearchResult[] = [];

  for (const item of json.results) {
    if (!isRecord(item)) {
      continue;
    }

    const url = typeof item.url === "string" ? item.url : "";

    if (url.length > 0) {
      out.push({
        title: typeof item.title === "string" ? item.title : "",
        url,
        snippet: typeof item.content === "string" ? item.content : "",
      });
    }
  }

  return out;
}

export function formatResults(results: readonly ISearchResult[]): string {
  if (results.length === 0) {
    return "no results found.";
  }

  return results
    .slice(0, MAX_RESULTS)
    .map((r, i) => {
      const head = r.title.length > 0 ? r.title : r.url;
      const snip = r.snippet.length > 0 ? `\n   ${r.snippet}` : "";

      return `${String(i + 1)}. ${head}\n   ${r.url}${snip}`;
    })
    .join("\n\n");
}

function buildSearchUrl(query: string): { url: string; searxng: boolean } {
  const base = process.env.TSFORGE_SEARXNG_URL;

  if (base !== undefined && base.length > 0) {
    const root = base.replace(/\/+$/, "");

    return {
      url: `${root}/search?q=${encodeURIComponent(query)}&format=json`,
      searxng: true,
    };
  }

  return {
    url: `${DDG_ENDPOINT}?q=${encodeURIComponent(query)}`,
    searxng: false,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `web_search` — discover sources for a query and return ranked title/url/snippet
 * results. Free and keyless: DuckDuckGo's HTML endpoint by default, or a
 * self-hosted SearXNG instance when TSFORGE_SEARXNG_URL is set. No paid API, no
 * vendor lock-in — everything runs from the user's machine.
 */
export async function doWebSearch(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: IWebSearchDeps = DEFAULT_DEPS
): Promise<string> {
  const query = str(args, "query").trim();

  if (query.length === 0) {
    return reject(
      ctx,
      "web_search",
      "web_search: `query` must be a non-empty search string."
    );
  }

  const { url, searxng } = buildSearchUrl(query);

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `↳ web_search ${query}`,
  });

  let text: string;

  try {
    const res = await deps.fetchFn(url);

    if (!res.ok) {
      return `web_search: backend returned HTTP ${String(res.status)} — retry, or set TSFORGE_SEARXNG_URL to a self-hosted instance.`;
    }

    text = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";

    return `web_search: search request failed — ${msg}`;
  }

  const results = searxng
    ? parseSearxngResults(safeJson(text))
    : parseDuckDuckGoResults(text);

  return formatResults(results);
}

async function realSearchFetch(url: string): Promise<ISearchResponse> {
  return fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; tsforge-web-search/1.0)",
      accept: "text/html,application/json",
    },
  });
}

const DEFAULT_DEPS: IWebSearchDeps = { fetchFn: realSearchFetch };
