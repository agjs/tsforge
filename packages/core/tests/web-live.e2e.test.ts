import { test, expect } from "bun:test";
import { doWebFetch } from "../src/loop/tools/web-fetch";
import { doWebSearch } from "../src/loop/tools/web-search";
import type { IToolContext } from "../src/loop/tools/execute-tool";

// Live network tests are OPT-IN (TSFORGE_WEB_LIVE_TESTS=1): they hit the real
// internet (Wikipedia, DuckDuckGo), so they're non-deterministic and out of the
// default suite. The tools' logic is exercised deterministically (mocked fetch)
// in web-fetch.test.ts / web-search.test.ts; this proves the real path end to
// end — actual GET, real readability extraction, real DDG markup parsing.
const enabled = process.env.TSFORGE_WEB_LIVE_TESTS === "1";
const liveTest = enabled ? test : test.skip;

const ctx = (): IToolContext => ({
  cwd: ".",
  files: [],
  task: "live",
  report: () => undefined,
});

liveTest(
  "web_fetch retrieves a real page and extracts readable markdown",
  async () => {
    const out = await doWebFetch(
      { url: "https://en.wikipedia.org/wiki/TypeScript", maxChars: 2000 },
      ctx()
    );

    expect(out.length).toBeGreaterThan(200);
    expect(out).toContain("TypeScript");
    // chrome/markup should be stripped — no raw HTML tags survive extraction.
    expect(out).not.toContain("<script");
    expect(out).not.toContain("</div>");
  },
  30_000
);

liveTest(
  "web_search returns real, decoded results from DuckDuckGo (no key)",
  async () => {
    const out = await doWebSearch({ query: "typescript handbook" }, ctx());

    expect(out).not.toContain("no results");
    expect(out.toLowerCase()).toContain("typescript");
    // result URLs must be the decoded destinations, not DDG redirect wrappers.
    expect(out).toContain("https://");
    expect(out).not.toContain("uddg=");
  },
  30_000
);
