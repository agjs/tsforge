import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCheck } from "../src/browser";
import { startStaticServer } from "../src/browser/oracle";

/** Write a tiny SPA fixture: one index.html whose inline script renders per
 *  location.pathname — throws on "/bad", leaves the root blank on "/blank". With
 *  the oracle's SPA fallback, visiting any path serves this file + the client
 *  "router" (the script) renders that route. */
async function spaFixture(): Promise<{
  file: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-crawl-"));
  const file = join(dir, "index.html");

  await writeFile(
    file,
    `<!doctype html><html><body><div id="root"></div><script>
       const p = location.pathname;
       if (p === "/bad") { throw new Error("boom on /bad route"); }
       if (p !== "/blank") {
         document.getElementById("root").innerHTML = "<h1>route " + p + "</h1>";
       }
     </script></body></html>`
  );

  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Skip these (don't fail) on machines/CI where chromium isn't installed. */
async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ args: ["--no-sandbox"] });

    await browser.close();

    return true;
  } catch {
    return false;
  }
}

// Real-chromium integration tests are OPT-IN (TSFORGE_BROWSER_TESTS=1): launching
// a browser inside `bun test` is timing-flaky under load, so it stays out of the
// default deterministic suite. The oracle's logic is exercised live regardless.
const enabled = process.env.TSFORGE_BROWSER_TESTS === "1";
const hasChromium = enabled && (await chromiumAvailable());
// skipped unless TSFORGE_BROWSER_TESTS=1 and Playwright chromium is installed
const browserTest = hasChromium ? test : test.skip;

// Static-server logic needs NO browser, so it runs in the default suite. Covers
// the 404/SPA-fallback contract AND the path-traversal guard (decodeURIComponent
// must not let `/..%2F…` escape the served root).
test("static server: 404s missing assets, SPA-falls-back, blocks ../ traversal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-static-"));
  const root = join(dir, "site");

  await mkdir(root, { recursive: true });
  await writeFile(join(root, "index.html"), "<h1>home</h1>");
  await writeFile(join(root, "app.js"), "console.log(1)");
  // a secret OUTSIDE the served root — traversal must never reach it
  await writeFile(join(dir, "secret.txt"), "TOPSECRET");

  const server = await startStaticServer(root);
  const base = `http://localhost:${String(server.port)}`;

  try {
    expect((await fetch(`${base}/app.js`)).status).toBe(200); // real asset

    const miss = await fetch(`${base}/missing.js`); // has a dot → 404, not index

    expect(miss.status).toBe(404);

    const route = await fetch(`${base}/some/route`); // extensionless → SPA fallback

    expect(route.status).toBe(200);
    expect(await route.text()).toContain("home");

    const trav = await fetch(`${base}/..%2Fsecret.txt`); // encoded ../ escape

    expect(trav.status).toBe(404);
    expect(await trav.text()).not.toContain("TOPSECRET");
  } finally {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

browserTest("renders clean HTML and confirms expected content", async () => {
  const result = await renderCheck({
    html: `<h1 id="title">Hello tsforge</h1>`,
    expect: { selector: "#title", text: "Hello tsforge" },
  });

  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
});

browserTest("fails on an uncaught runtime error", async () => {
  const result = await renderCheck({
    html: `<body><script>throw new Error("boom at runtime");</script></body>`,
  });

  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toContain("boom at runtime");
});

browserTest("fails when an expected selector is missing", async () => {
  const result = await renderCheck({
    html: `<h1>nothing here</h1>`,
    expect: { selector: "#does-not-exist" },
  });

  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toContain("#does-not-exist");
});

browserTest(
  "verifies INTERACTION: clicking the button increments the count",
  async () => {
    const html = `
    <button id="inc">+</button><span id="count">0</span>
    <script>
      const c = document.getElementById("count");
      document.getElementById("inc").addEventListener("click", () => {
        c.textContent = String(Number(c.textContent) + 1);
      });
    </script>`;

    const result = await renderCheck({
      html,
      steps: [
        { click: "#inc", expect: { selector: "#count", text: "1" } },
        { click: "#inc", expect: { selector: "#count", text: "2" } },
      ],
    });

    expect(result.ok).toBe(true);
  }
);

browserTest("interaction: a broken handler is caught", async () => {
  const html = `
    <button id="inc">+</button><span id="count">0</span>
    <script>
      document.getElementById("inc").addEventListener("click", () => {
        /* bug: never updates #count */
      });
    </script>`;

  const result = await renderCheck({
    html,
    steps: [{ click: "#inc", expect: { selector: "#count", text: "1" } }],
  });

  expect(result.ok).toBe(false);
});

browserTest(
  "smoke: passes when the app mounts and buttons are safe",
  async () => {
    const result = await renderCheck({
      html: `<div id="root"><h1>App</h1><button>noop</button></div>`,
      smoke: true,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  }
);

browserTest("smoke: fails on a blank root (silent white screen)", async () => {
  const result = await renderCheck({
    html: `<div id="root"></div>`,
    smoke: true,
  });

  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toContain("did not mount");
});

browserTest(
  "crawl: all routes render → ok (SPA fallback serves each path)",
  async () => {
    const { file, cleanup } = await spaFixture();

    try {
      const result = await renderCheck({
        file,
        routes: ["/", "/accounts", "/accounts/create"],
      });

      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      await cleanup();
    }
  }
);

browserTest("crawl: a route that throws is caught", async () => {
  const { file, cleanup } = await spaFixture();

  try {
    const result = await renderCheck({ file, routes: ["/accounts", "/bad"] });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("boom on /bad");
  } finally {
    await cleanup();
  }
});

browserTest("crawl: a route that renders blank is caught", async () => {
  const { file, cleanup } = await spaFixture();

  try {
    const result = await renderCheck({ file, routes: ["/blank"] });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("/blank rendered blank");
  } finally {
    await cleanup();
  }
});

browserTest("smoke: fails when clicking a button throws", async () => {
  const result = await renderCheck({
    html: `<div id="root"><h1>App</h1>
      <button onclick="throw new Error('boom on click')">Go</button></div>`,
    smoke: true,
  });

  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toContain("boom on click");
});
