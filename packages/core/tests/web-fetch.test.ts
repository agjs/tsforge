import { test, expect } from "bun:test";
import {
  validateFetchUrl,
  doWebFetch,
  fetchFollowingRedirects,
  type IWebFetchDeps,
  type RawFetch,
} from "../src/loop/tools/web-fetch";
import type { IToolContext } from "../src/loop/tools/execute-tool";

const ctx = (): IToolContext => ({
  cwd: ".",
  files: [],
  task: "t",
  report: () => undefined,
});

const deps = (over: Partial<IWebFetchDeps>): IWebFetchDeps => ({
  fetchFn: async () => ({
    ok: true,
    status: 200,
    text: async () => "<html><body><p>hi</p></body></html>",
  }),
  extract: async (html) => `extracted:${html.length}`,
  ...over,
});

test("validateFetchUrl accepts http and https", () => {
  expect(validateFetchUrl("https://example.com/docs")?.protocol).toBe("https:");
  expect(validateFetchUrl("http://example.com")?.protocol).toBe("http:");
});

test("validateFetchUrl rejects non-http(s) and malformed URLs", () => {
  expect(validateFetchUrl("file:///etc/passwd")).toBeNull();
  expect(validateFetchUrl("javascript:alert(1)")).toBeNull();
  expect(validateFetchUrl("ftp://example.com")).toBeNull();
  expect(validateFetchUrl("not a url")).toBeNull();
  expect(validateFetchUrl("")).toBeNull();
});

test("validateFetchUrl rejects localhost and private addresses (SSRF guard)", () => {
  expect(validateFetchUrl("http://localhost:8080")).toBeNull();
  expect(validateFetchUrl("http://127.0.0.1/")).toBeNull();
  expect(
    validateFetchUrl("http://169.254.169.254/latest/meta-data")
  ).toBeNull();
  expect(validateFetchUrl("http://10.0.0.5/")).toBeNull();
  expect(validateFetchUrl("http://192.168.1.1/")).toBeNull();
});

test("validateFetchUrl rejects IPv6 private + IPv4-mapped loopback (SSRF guard)", () => {
  expect(validateFetchUrl("http://[::1]/")).toBeNull(); // loopback
  expect(validateFetchUrl("http://[fc00::1]/")).toBeNull(); // ULA fc00::/7
  expect(validateFetchUrl("http://[fd12:3456::1]/")).toBeNull(); // ULA
  expect(validateFetchUrl("http://[fe80::1]/")).toBeNull(); // link-local
  expect(validateFetchUrl("http://[::ffff:127.0.0.1]/")).toBeNull(); // mapped loopback
  expect(validateFetchUrl("http://[::ffff:169.254.169.254]/")).toBeNull(); // mapped metadata
});

test("fetchFollowingRedirects re-validates each hop and blocks a redirect to localhost", async () => {
  // A public URL 302-redirecting to localhost (the classic SSRF bypass of a
  // one-time upfront host check) must be refused at the hop, not followed.
  const raw: RawFetch = async (url) => {
    if (url === "https://evil.example.com/") {
      return {
        ok: false,
        status: 302,
        headers: {
          get: (n) => (n === "location" ? "http://127.0.0.1/" : null),
        },
        text: async () => "",
      };
    }

    throw new Error(`should never fetch ${url}`);
  };

  await expect(
    fetchFollowingRedirects("https://evil.example.com/", raw)
  ).rejects.toThrow(/non-public host/u);
});

test("fetchFollowingRedirects follows a redirect to another public host", async () => {
  const raw: RawFetch = async (url) => {
    if (url === "https://a.example.com/") {
      return {
        ok: false,
        status: 301,
        headers: {
          get: (n) => (n === "location" ? "https://b.example.com/" : null),
        },
        text: async () => "",
      };
    }

    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "final",
    };
  };

  const res = await fetchFollowingRedirects("https://a.example.com/", raw);

  expect(res.status).toBe(200);
  expect(await res.text()).toBe("final");
});

test("doWebFetch rejects an invalid URL without touching the network", async () => {
  let called = false;
  const r = await doWebFetch(
    { url: "file:///etc/passwd" },
    ctx(),
    deps({
      fetchFn: async () => {
        called = true;

        throw new Error("should not be called");
      },
    })
  );

  expect(called).toBe(false);
  expect(r).toContain("web_fetch");
});

test("doWebFetch returns extracted content on success", async () => {
  const r = await doWebFetch(
    { url: "https://example.com" },
    ctx(),
    deps({ extract: async () => "# Title\n\nbody text" })
  );

  expect(r).toContain("# Title");
  expect(r).toContain("body text");
});

test("doWebFetch truncates long content to maxChars with a marker", async () => {
  const r = await doWebFetch(
    { url: "https://example.com", maxChars: 100 },
    ctx(),
    deps({ extract: async () => "x".repeat(50_000) })
  );

  expect(r.length).toBeLessThan(500);
  expect(r.toLowerCase()).toContain("truncated");
});

test("doWebFetch reports a non-OK HTTP status instead of throwing", async () => {
  const r = await doWebFetch(
    { url: "https://example.com" },
    ctx(),
    deps({
      fetchFn: async () => ({ ok: false, status: 404, text: async () => "" }),
    })
  );

  expect(r).toContain("404");
});

test("doWebFetch handles a network error gracefully", async () => {
  const r = await doWebFetch(
    { url: "https://example.com" },
    ctx(),
    deps({
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    })
  );

  expect(r.toLowerCase()).toContain("failed");
});
