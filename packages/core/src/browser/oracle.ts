import { resolve, dirname, basename, join } from "node:path";
// `playwright` is an OPTIONAL peer: bundling it (+ a browser binary) into every
// install is too heavy, so the import is dynamic and the render-check skips when
// it's absent. The type-only import is erased at runtime, so it can't crash a
// playwright-less install.
import type { Page, chromium as Chromium } from "playwright";

/** Load playwright's chromium lazily; null when it isn't installed. */
async function loadChromium(): Promise<typeof Chromium | null> {
  try {
    return (await import("playwright")).chromium;
  } catch {
    return null;
  }
}

/**
 * The browser oracle — renders a built web page in headless chromium and reports
 * whether it actually WORKS, beyond what tsc/eslint can see: it fails on uncaught
 * exceptions, console errors, and missing expected content. This is the layer
 * that verifies the model's web UI runs, not just that it type-checks. Bundled
 * (tsforge brings its own chromium) so any project can be browser-checked with no
 * per-project setup. `--no-sandbox` so it runs in WSL / a container.
 */
export interface IRenderExpect {
  /** A CSS selector that must be present after load. */
  selector?: string;
  /** Text the selector (or the body) must contain. */
  text?: string;
}

/** An interaction step: optionally fill an input and/or click, then assert. */
export interface IStep {
  click?: string;
  fill?: { selector: string; value: string };
  expect?: IRenderExpect;
}

export interface IRenderOptions {
  /** Path to an HTML file to open (served over http), OR inline `html`. */
  file?: string;
  html?: string;
  expect?: IRenderExpect;
  /** Interaction steps run after load — click/fill, then assert. Verifies the
   *  app actually WORKS (e.g. click increments), not just that it renders. */
  steps?: IStep[];
  /** Generic, app-agnostic behaviour smoke (harness-authored, not model-authored):
   *  assert the app actually mounted (root not blank) and that clicking the first
   *  few buttons throws no uncaught/console error. Catches apps that crash on
   *  interaction without needing per-app checks. */
  smoke?: boolean;
  /** Static URL paths to crawl after the initial load (e.g. "/accounts",
   *  "/accounts/create"): each is visited and must render non-blank with no
   *  console/page error. Catches routes that EXIST but are stub/broken — a
   *  single-page smoke misses them. Served with SPA fallback so the client
   *  router handles the path. Empty/undefined → no crawl (unchanged behavior). */
  routes?: string[];
  /** Navigation timeout (default 15s). */
  timeoutMs?: number;
}

export interface IRenderResult {
  ok: boolean;
  /** Human-readable failures (console errors, page errors, missing content). */
  errors: string[];
  /** True when the check was skipped because playwright isn't installed. */
  skipped?: boolean;
}

export async function renderCheck(
  opts: IRenderOptions
): Promise<IRenderResult> {
  const errors: string[] = [];
  const chromium = await loadChromium();

  // No playwright → skip the render check rather than fail the gate. The build
  // still ran tsc/eslint/build/stub-check; the browser smoke is an enhancement.
  if (chromium === null) {
    process.stderr.write(
      "browser render-check skipped: playwright not installed " +
        "(run `bunx playwright install chromium` to enable it)\n"
    );

    return { ok: true, errors: [], skipped: true };
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });

  try {
    const page = await browser.newPage();
    const timeout = opts.timeoutMs ?? 15_000;

    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(`console error: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      errors.push(`uncaught: ${error.message}`);
    });

    // A file is served over http (NOT file://) so `<script type="module">` and
    // relative fetches load — browsers block ES modules over file://. Inline
    // `html` goes straight to setContent. For a file, the server stays up across
    // ALL checks (incl the route crawl, which needs SPA fallback).
    if (opts.file !== undefined) {
      const abs = resolve(opts.file);
      const server = startStaticServer(dirname(abs));
      const base = `http://localhost:${String(server.port)}`;

      try {
        await page.goto(`${base}/${basename(abs)}`, {
          waitUntil: "load",
          timeout,
        });
        await runChecks(page, opts, errors);

        if (opts.routes !== undefined && opts.routes.length > 0) {
          await crawlRoutes(page, base, opts.routes, errors, timeout);
        }
      } finally {
        await server.stop(true);
      }
    } else {
      await page.setContent(opts.html ?? "", { waitUntil: "load", timeout });
      await runChecks(page, opts, errors);
    }

    return { ok: errors.length === 0, errors };
  } finally {
    await browser.close();
  }
}

/** The expectation + step + smoke checks that run against the loaded page. */
async function runChecks(
  page: Page,
  opts: IRenderOptions,
  errors: string[]
): Promise<void> {
  await checkExpectations(page, opts.expect, errors);

  for (const step of opts.steps ?? []) {
    await runStep(page, step, errors);
  }

  if (opts.smoke === true) {
    await runSmoke(page, errors);
  }
}

/** Serve a directory on an ephemeral localhost port. SPA FALLBACK: an
 *  extension-less path that isn't a real file → index.html (so the client router
 *  renders that route). Missing ASSETS (paths with a `.`) still 404, so a broken
 *  bundle/import surfaces as a real error. */
function startStaticServer(root: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch: async (req): Promise<Response> => {
      const path = new URL(req.url).pathname;
      const rel =
        path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
      const handle = Bun.file(join(root, rel));

      if (await handle.exists()) {
        return new Response(handle);
      }

      if (!rel.includes(".")) {
        const index = Bun.file(join(root, "index.html"));

        if (await index.exists()) {
          return new Response(index);
        }
      }

      return new Response("not found", { status: 404 });
    },
  });
}

/** Visit each route and assert it renders non-blank; console/page errors during
 *  these navigations are captured by the handlers wired in renderCheck. A route
 *  that errors or paints a blank root is a real defect a single-page smoke misses. */
async function crawlRoutes(
  page: Page,
  base: string,
  routes: readonly string[],
  errors: string[],
  timeout: number
): Promise<void> {
  for (const route of routes) {
    try {
      await page.goto(`${base}${route}`, { waitUntil: "load", timeout });
      // Let the client router + first paint settle before the blank check (the
      // shell/nav renders immediately, so this only flags genuinely dead routes).
      await page.waitForTimeout(150);

      const blank = await page.evaluate(() => {
        const root =
          document.querySelector("#root") ??
          document.querySelector("#app") ??
          document.body;

        return root.children.length === 0 || root.textContent.trim() === "";
      });

      if (blank) {
        errors.push(`route ${route} rendered blank`);
      }
    } catch (error) {
      errors.push(
        `route ${route} failed to load: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/** Max interactive elements the generic smoke will click. */
const SMOKE_CLICK_LIMIT = 5;

/**
 * Generic, app-agnostic behaviour smoke. First proves the app MOUNTED (the React
 * root has rendered content — a blank white screen is a silent failure tsc/eslint
 * never catch). Then clicks the first few enabled buttons; any uncaught exception
 * or console error surfaces via the page handlers wired in renderCheck. No per-app
 * knowledge, so it never needs the model to author (flaky) checks.
 */
async function runSmoke(page: Page, errors: string[]): Promise<void> {
  const mounted = await page.evaluate(() => {
    const root =
      document.querySelector("#root") ??
      document.querySelector("#app") ??
      document.body;

    return root.children.length > 0 && root.textContent.trim() !== "";
  });

  if (!mounted) {
    errors.push("app did not mount: root is blank after load");

    return;
  }

  // Click buttons only (not links — links navigate away from the SPA). The error
  // handlers in renderCheck capture anything an onClick throws.
  const buttons = await page.$$('button:not([disabled]), [role="button"]');
  const limit = Math.min(buttons.length, SMOKE_CLICK_LIMIT);

  for (let i = 0; i < limit; i++) {
    try {
      const button = buttons[i];

      if (button !== undefined) {
        await button.click({ timeout: 2000, trial: false });
        await page.waitForTimeout(50);
      }
    } catch {
      // A click that can't land (covered/detached) is not a behaviour failure;
      // only uncaught JS errors (captured by the page handlers) count.
    }
  }
}

/** Run one interaction step (fill, then click, then assert) against the page. */
async function runStep(
  page: Page,
  step: IStep,
  errors: string[]
): Promise<void> {
  if (step.fill !== undefined) {
    try {
      await page.fill(step.fill.selector, step.fill.value, { timeout: 3000 });
    } catch {
      errors.push(`could not fill ${step.fill.selector}`);
    }
  }

  if (step.click !== undefined) {
    try {
      await page.click(step.click, { timeout: 3000 });
    } catch {
      errors.push(`could not click ${step.click}`);
    }
  }

  if (step.expect !== undefined) {
    await checkExpectations(page, step.expect, errors);
  }
}

async function checkExpectations(
  page: Page,
  expect: IRenderExpect | undefined,
  errors: string[]
): Promise<void> {
  if (expect === undefined) {
    return;
  }

  // No selector → an optional whole-page text check.
  if (expect.selector === undefined) {
    if (expect.text !== undefined) {
      const body = (await page.textContent("body")) ?? "";

      if (!body.includes(expect.text)) {
        errors.push(`page is missing expected text: "${expect.text}"`);
      }
    }

    return;
  }

  const element = await page.$(expect.selector);

  if (element === null) {
    errors.push(`expected selector not found: ${expect.selector}`);

    return;
  }

  if (expect.text !== undefined) {
    const text = (await element.textContent()) ?? "";

    if (!text.includes(expect.text)) {
      errors.push(
        `${expect.selector} is missing "${expect.text}" (got "${text.slice(0, 60)}")`
      );
    }
  }
}
