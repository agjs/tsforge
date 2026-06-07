import { resolve, dirname, basename, join } from "node:path";
import { chromium, type Page } from "playwright";

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
  /** Navigation timeout (default 15s). */
  timeoutMs?: number;
}

export interface IRenderResult {
  ok: boolean;
  /** Human-readable failures (console errors, page errors, missing content). */
  errors: string[];
}

export async function renderCheck(
  opts: IRenderOptions
): Promise<IRenderResult> {
  const errors: string[] = [];
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
    // `html` goes straight to setContent.
    await (opts.file !== undefined
      ? loadOverHttp(page, opts.file, timeout)
      : page.setContent(opts.html ?? "", { waitUntil: "load", timeout }));

    await checkExpectations(page, opts.expect, errors);

    for (const step of opts.steps ?? []) {
      await runStep(page, step, errors);
    }

    return { ok: errors.length === 0, errors };
  } finally {
    await browser.close();
  }
}

/** Serve `file`'s directory on an ephemeral localhost port and navigate to it. */
async function loadOverHttp(
  page: Page,
  file: string,
  timeout: number
): Promise<void> {
  const abs = resolve(file);
  const root = dirname(abs);
  const server = Bun.serve({
    port: 0,
    fetch: async (req): Promise<Response> => {
      const path = new URL(req.url).pathname;
      const rel =
        path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
      const handle = Bun.file(join(root, rel));

      return (await handle.exists())
        ? new Response(handle)
        : new Response("not found", { status: 404 });
    },
  });

  try {
    await page.goto(
      `http://localhost:${String(server.port)}/${basename(abs)}`,
      {
        waitUntil: "load",
        timeout,
      }
    );
  } finally {
    await server.stop(true);
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
