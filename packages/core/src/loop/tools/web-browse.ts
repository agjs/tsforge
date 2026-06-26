import type { chromium as Chromium } from "playwright";
import { reject, str, type IToolContext } from "./tool-context";
import { validateFetchUrl } from "./web-fetch";

const DEFAULT_MAX_CHARS = 10_000;
const MAX_ALLOWED_CHARS = 40_000;
const MAX_LINKS = 12;

export interface IBrowseLink {
  text: string;
  href: string;
}

export interface IBrowsePage {
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number }
  ): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  close(): Promise<void>;
  route(
    pattern: string,
    handler: (route: IBrowseRoute) => Promise<void> | void
  ): Promise<unknown>;
}

export interface IBrowseRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
}

export interface IBrowseBrowser {
  newPage(): Promise<IBrowsePage>;
  close(): Promise<void>;
}

export interface IWebBrowseDeps {
  launchBrowser: () => Promise<IBrowseBrowser | null>;
}

async function loadBrowser(): Promise<IBrowseBrowser | null> {
  let chromium: typeof Chromium;

  try {
    chromium = (await import("playwright")).chromium;
  } catch {
    return null;
  }

  return chromium.launch({ args: ["--no-sandbox"] });
}

function maxChars(args: Record<string, unknown>): number {
  const value = args.maxChars;

  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(Math.floor(value), MAX_ALLOWED_CHARS);
  }

  return DEFAULT_MAX_CHARS;
}

function waitMs(args: Record<string, unknown>): number {
  const value = args.waitMs;

  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.min(Math.floor(value), 10_000);
  }

  return 750;
}

function truncate(content: string, max: number): string {
  const trimmed = content.trim();

  if (trimmed.length <= max) {
    return trimmed;
  }

  return `${trimmed.slice(0, max)}\n\n...[truncated ${String(trimmed.length - max)} chars - raise maxChars to read more]`;
}

async function installRequestGuard(page: IBrowsePage): Promise<void> {
  await page.route("**/*", async (route) => {
    if (validateFetchUrl(route.request().url()) === null) {
      await route.abort();

      return;
    }

    await route.continue();
  });
}

function renderLinks(links: readonly IBrowseLink[]): string {
  if (links.length === 0) {
    return "(none)";
  }

  return links
    .slice(0, MAX_LINKS)
    .map((link, index) => {
      const label = link.text.length > 0 ? link.text : link.href;

      return `${String(index + 1)}. ${label}\n   ${link.href}`;
    })
    .join("\n");
}

async function visibleText(page: IBrowsePage): Promise<string> {
  // document.body can be absent on a blank/failed load; the index lookup is
  // genuinely nullable, so evaluate returns "" instead of throwing a TypeError.
  return page.evaluate(
    () => document.getElementsByTagName("body")[0]?.innerText ?? ""
  );
}

async function visibleLinks(page: IBrowsePage): Promise<IBrowseLink[]> {
  return page.evaluate(() => {
    const out: IBrowseLink[] = [];

    for (const anchor of document.querySelectorAll("a")) {
      const href = anchor.href;

      if (href.length === 0) {
        continue;
      }

      out.push({
        text: anchor.textContent.replace(/\s+/gu, " ").trim(),
        href,
      });
    }

    return out;
  });
}

export async function doWebBrowse(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: IWebBrowseDeps = DEFAULT_DEPS
): Promise<string> {
  const url = validateFetchUrl(str(args, "url"));

  if (url === null) {
    return reject(
      ctx,
      "web_browse",
      "web_browse: `url` must be an absolute http(s) URL to a public host."
    );
  }

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `↳ web_browse ${url.href}`,
  });

  const browser = await deps.launchBrowser();

  if (browser === null) {
    return (
      "web_browse: Playwright is not installed or Chromium is unavailable. " +
      "Use web_fetch for static pages, or install Playwright locally to enable browser browsing."
    );
  }

  try {
    const page = await browser.newPage();

    try {
      await installRequestGuard(page);
      await page.goto(url.href, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      await page.waitForTimeout(waitMs(args));

      const title = await page.title();
      const text = await visibleText(page);
      const links = await visibleLinks(page);
      const body = [
        `# ${title.length > 0 ? title : page.url()}`,
        `url: ${page.url()}`,
        "",
        truncate(text, maxChars(args)),
        "",
        "## Links",
        renderLinks(links),
      ].join("\n");

      return body.trim();
    } finally {
      await page.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";

    return `web_browse: failed to browse ${url.href} - ${message}`;
  } finally {
    await browser.close();
  }
}

const DEFAULT_DEPS: IWebBrowseDeps = { launchBrowser: loadBrowser };
