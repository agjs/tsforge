import { test, expect, afterEach } from "bun:test";
import {
  parseDuckDuckGoResults,
  formatResults,
  doWebSearch,
  type IWebSearchDeps,
} from "../src/loop/tools/web-search";
import type { IToolContext } from "../src/loop/tools/execute-tool";

const ctx = (): IToolContext => ({
  cwd: ".",
  files: [],
  task: "t",
  report: () => undefined,
});

// A trimmed sample of DuckDuckGo's HTML result markup: the first link uses the
// `uddg=` redirect wrapper (which must be decoded back to the real URL), the
// second is a direct href.
const DDG_HTML = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc">TypeScript <b>Docs</b></a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">The official <b>handbook</b>.</a>
</div>
<div class="result">
  <a class="result__a" href="https://other.com">Other</a>
  <a class="result__snippet">second snippet</a>
</div>`;

const deps = (over: Partial<IWebSearchDeps>): IWebSearchDeps => ({
  fetchFn: async () => ({ ok: true, status: 200, text: async () => DDG_HTML }),
  ...over,
});

afterEach(() => {
  delete process.env.TSFORGE_SEARXNG_URL;
});

test("parseDuckDuckGoResults extracts title, decoded url, and snippet", () => {
  const r = parseDuckDuckGoResults(DDG_HTML);

  expect(r.length).toBe(2);
  expect(r[0]?.title).toBe("TypeScript Docs");
  expect(r[0]?.url).toBe("https://example.com/docs");
  expect(r[0]?.snippet).toContain("handbook");
  expect(r[1]?.url).toBe("https://other.com");
});

test("formatResults lists each result with title, url, and snippet", () => {
  const out = formatResults([
    { title: "Foo", url: "https://a.com", snippet: "about foo" },
  ]);

  expect(out).toContain("Foo");
  expect(out).toContain("https://a.com");
  expect(out).toContain("about foo");
});

test("formatResults reports when there are no results", () => {
  expect(formatResults([]).toLowerCase()).toContain("no results");
});

test("doWebSearch rejects an empty query without touching the network", async () => {
  let called = false;
  const r = await doWebSearch(
    { query: "" },
    ctx(),
    deps({
      fetchFn: async () => {
        called = true;

        throw new Error("should not be called");
      },
    })
  );

  expect(called).toBe(false);
  expect(r).toContain("web_search");
});

test("doWebSearch returns formatted results from the free DuckDuckGo backend (no key)", async () => {
  const r = await doWebSearch({ query: "typescript docs" }, ctx(), deps({}));

  expect(r).toContain("https://example.com/docs");
  expect(r).toContain("https://other.com");
});

test("doWebSearch reports an HTTP error status gracefully", async () => {
  const r = await doWebSearch(
    { query: "x" },
    ctx(),
    deps({
      fetchFn: async () => ({ ok: false, status: 503, text: async () => "" }),
    })
  );

  expect(r).toContain("503");
});

test("doWebSearch routes to a self-hosted SearXNG instance when TSFORGE_SEARXNG_URL is set", async () => {
  process.env.TSFORGE_SEARXNG_URL = "http://localhost:8888";
  let requested = "";
  const json = JSON.stringify({
    results: [{ title: "S", url: "https://s.com", content: "searx snippet" }],
  });
  const r = await doWebSearch(
    { query: "rust" },
    ctx(),
    deps({
      fetchFn: async (u) => {
        requested = u;

        return { ok: true, status: 200, text: async () => json };
      },
    })
  );

  expect(requested).toContain("localhost:8888");
  expect(requested).toContain("format=json");
  expect(r).toContain("https://s.com");
  expect(r).toContain("searx snippet");
});
