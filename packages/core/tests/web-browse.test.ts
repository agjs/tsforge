import { test, expect } from "bun:test";
import { doWebBrowse, type IWebBrowseDeps } from "../src/loop/tools/web-browse";
import type { IToolContext } from "../src/loop/tools/tool-context";

function ctx(): IToolContext {
  return { cwd: ".", files: [], task: "t", report: () => undefined };
}

test("doWebBrowse rejects invalid URLs without launching a browser", async () => {
  let launched = false;
  const deps: IWebBrowseDeps = {
    launchBrowser: async () => {
      launched = true;

      return null;
    },
  };
  const out = await doWebBrowse({ url: "file:///etc/passwd" }, ctx(), deps);

  expect(launched).toBe(false);
  expect(out).toContain("web_browse");
});

test("doWebBrowse explains when local Playwright is unavailable", async () => {
  const out = await doWebBrowse({ url: "https://example.com" }, ctx(), {
    launchBrowser: async () => null,
  });

  expect(out).toContain("Playwright");
  expect(out).toContain("web_fetch");
});
