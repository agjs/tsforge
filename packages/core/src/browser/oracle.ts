import { resolve, dirname, basename, join } from "node:path";
import { isRecord } from "../lib/guards";
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

/** Run axe against a page and return its raw result; null when @axe-core/
 *  playwright isn't installed (a11y is an optional enhancement, like the browser
 *  itself). Kept untyped at the boundary — extractAxeViolations narrows it. */
async function runAxe(page: Page): Promise<unknown> {
  try {
    const mod = await import("@axe-core/playwright");
    const builder = new mod.AxeBuilder({ page });

    return await builder.analyze();
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
  /** Run axe accessibility checks on the page (and each crawled route). Serious
   *  and critical violations become gate errors; minor/moderate are skipped.
   *  Skipped gracefully when @axe-core/playwright isn't installed. */
  a11y?: boolean;
  /** Directory to write a screenshot per page/route into (desktop + mobile
   *  viewports). An artifact for human/visual review — never a pass/fail signal. */
  screenshotDir?: string;
  /** A perf budget (DOM node count + mount time) checked on the initial page. */
  perfBudget?: IPerfBudget;
  /** Navigation timeout (default 15s). */
  timeoutMs?: number;
}

/** Screenshot viewports — a desktop and a mobile pass per page. */
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const;

export interface IRenderResult {
  ok: boolean;
  /** Human-readable failures (console errors, page errors, missing content). */
  errors: string[];
  /** True when the check was skipped because playwright isn't installed. */
  skipped?: boolean;
  /** Paths of screenshots captured (when `screenshotDir` was set). */
  screenshots?: string[];
}

/** A simple performance budget: fail the render when the built app blows past
 *  these. Intentionally minimal (no full Lighthouse) — a tripwire, not a profiler. */
export interface IPerfBudget {
  /** Max total DOM nodes after load (a proxy for over-heavy render trees). */
  maxDomNodes?: number;
  /** Max time from navigation start to DOMContentLoaded, in ms. */
  maxMountMs?: number;
}

/** axe impact levels that FAIL the a11y check — minor/moderate are reported by
 *  axe but don't gate (too noisy to block a build on). */
const AXE_FAIL_IMPACTS = new Set(["serious", "critical"]);

/** The subset of an axe violation the oracle reports on. */
interface IAxeViolation {
  id: string;
  impact: string | undefined;
  nodeCount: number;
}

/** Extract the reportable violations from axe's (untyped, dynamically-imported)
 *  result — narrowed with guards, no casts. */
function extractAxeViolations(result: unknown): IAxeViolation[] {
  if (!isRecord(result) || !Array.isArray(result.violations)) {
    return [];
  }

  const out: IAxeViolation[] = [];

  for (const v of result.violations) {
    if (!isRecord(v) || typeof v.id !== "string") {
      continue;
    }

    out.push({
      id: v.id,
      impact: typeof v.impact === "string" ? v.impact : undefined,
      nodeCount: Array.isArray(v.nodes) ? v.nodes.length : 0,
    });
  }

  return out;
}

/** Turn axe violations into gate errors — only serious/critical fail. Pure. */
export function summarizeAxeViolations(
  violations: readonly IAxeViolation[],
  where: string
): string[] {
  return violations
    .filter((v) => v.impact !== undefined && AXE_FAIL_IMPACTS.has(v.impact))
    .map(
      (v) =>
        `a11y ${v.impact ?? "?"} at ${where}: ${v.id} (${String(v.nodeCount)} node(s))`
    );
}

/** Evaluate a perf budget against measured values → gate errors. Pure. */
export function checkPerfBudget(
  domNodes: number,
  mountMs: number,
  budget: IPerfBudget,
  where: string
): string[] {
  const errors: string[] = [];

  if (budget.maxDomNodes !== undefined && domNodes > budget.maxDomNodes) {
    errors.push(
      `perf at ${where}: ${String(domNodes)} DOM nodes > budget ${String(budget.maxDomNodes)}`
    );
  }

  if (budget.maxMountMs !== undefined && mountMs > budget.maxMountMs) {
    errors.push(
      `perf at ${where}: mount ${String(Math.round(mountMs))}ms > budget ${String(budget.maxMountMs)}ms`
    );
  }

  return errors;
}

export async function renderCheck(
  opts: IRenderOptions
): Promise<IRenderResult> {
  const errors: string[] = [];
  const screenshots: string[] = [];
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
    // Page via an explicit context (not browser.newPage()) — axe-core/playwright
    // requires a context-owned page; browser.close() tears the context down too.
    const context = await browser.newContext();
    const page = await context.newPage();
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
        await runChecks(page, opts, errors, screenshots);

        if (opts.routes !== undefined && opts.routes.length > 0) {
          await crawlRoutes(page, base, opts.routes, errors, timeout, {
            opts,
            screenshots,
          });
        }
      } finally {
        await server.stop(true);
      }
    } else {
      await page.setContent(opts.html ?? "", { waitUntil: "load", timeout });
      await runChecks(page, opts, errors, screenshots);
    }

    return {
      ok: errors.length === 0,
      errors,
      ...(screenshots.length > 0 ? { screenshots } : {}),
    };
  } finally {
    await browser.close();
  }
}

/** The expectation + step + smoke checks that run against the loaded page, then
 *  the optional quality oracles (a11y, perf budget, screenshots). */
async function runChecks(
  page: Page,
  opts: IRenderOptions,
  errors: string[],
  screenshots: string[]
): Promise<void> {
  await checkExpectations(page, opts.expect, errors);

  for (const step of opts.steps ?? []) {
    await runStep(page, step, errors);
  }

  if (opts.smoke === true) {
    await runSmoke(page, errors);
  }

  await runQualityOracles(page, opts, "index", errors, screenshots);
}

/** The opt-in quality layer: accessibility (axe), a perf budget, and screenshots.
 *  Each is independent and skips cleanly when not requested / dep absent. */
async function runQualityOracles(
  page: Page,
  opts: IRenderOptions,
  where: string,
  errors: string[],
  screenshots: string[]
): Promise<void> {
  if (opts.a11y === true) {
    const violations = extractAxeViolations(await runAxe(page));

    errors.push(...summarizeAxeViolations(violations, where));
  }

  if (opts.perfBudget !== undefined) {
    const { domNodes, mountMs } = await measurePage(page);

    errors.push(...checkPerfBudget(domNodes, mountMs, opts.perfBudget, where));
  }

  if (opts.screenshotDir !== undefined) {
    await capturePage(page, opts.screenshotDir, where, screenshots);
  }
}

/** Measure DOM size + mount time for the perf budget. */
async function measurePage(
  page: Page
): Promise<{ domNodes: number; mountMs: number }> {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const mountMs =
      nav instanceof PerformanceNavigationTiming
        ? nav.domContentLoadedEventEnd - nav.startTime
        : 0;

    return { domNodes: document.querySelectorAll("*").length, mountMs };
  });
}

/** Filesystem-safe label for a route (e.g. "/a/b" → "a-b", "/" → "index"). */
function routeLabel(route: string): string {
  const cleaned = route.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");

  return cleaned.length === 0 ? "index" : cleaned;
}

/** Capture a desktop + mobile screenshot of the current page into `dir`. */
async function capturePage(
  page: Page,
  dir: string,
  label: string,
  screenshots: string[]
): Promise<void> {
  for (const vp of VIEWPORTS) {
    const path = join(dir, `${label}-${vp.name}.png`);

    try {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.screenshot({ path, fullPage: true });
      screenshots.push(path);
    } catch {
      // A screenshot is a best-effort artifact, never a gate failure.
    }
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
  timeout: number,
  quality: { opts: IRenderOptions; screenshots: string[] }
): Promise<void> {
  for (const route of routes) {
    try {
      await page.goto(`${base}${route}`, { waitUntil: "load", timeout });

      // Poll for first paint before the blank check, so a route that mounts
      // ASYNCHRONOUSLY (after MSW's worker.start() resolves, or any await-before-
      // render bootstrap) isn't misjudged dead. Only a genuinely empty root fails.
      if (!(await waitForMount(page))) {
        errors.push(`route ${route} rendered blank`);
        continue;
      }

      // a11y + screenshots per route (perf budget stays an initial-page check).
      await runQualityOracles(
        page,
        { ...quality.opts, perfBudget: undefined },
        routeLabel(route),
        errors,
        quality.screenshots
      );
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
/** Wait for the app to paint content into its root — polls up to `timeoutMs`, so an
 *  app that renders ASYNCHRONOUSLY (after MSW's worker.start() resolves, or any
 *  await-before-mount bootstrap) is not misjudged "blank" by a check that fires the
 *  instant `load` does. Returns true once mounted, false on timeout. */
async function waitForMount(page: Page, timeoutMs = 5000): Promise<boolean> {
  return page
    .waitForFunction(
      () => {
        const root =
          document.querySelector("#root") ??
          document.querySelector("#app") ??
          document.body;

        return root.children.length > 0 && root.textContent.trim() !== "";
      },
      undefined,
      { timeout: timeoutMs, polling: 100 }
    )
    .then(() => true)
    .catch(() => false);
}

async function runSmoke(page: Page, errors: string[]): Promise<void> {
  const mounted = await waitForMount(page);

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
