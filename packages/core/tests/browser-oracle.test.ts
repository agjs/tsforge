import { test, expect } from "bun:test";
import { renderCheck } from "../src/browser";

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
const browserTest = hasChromium ? test : test.skip;

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

browserTest("smoke: fails when clicking a button throws", async () => {
  const result = await renderCheck({
    html: `<div id="root"><h1>App</h1>
      <button onclick="throw new Error('boom on click')">Go</button></div>`,
    smoke: true,
  });

  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toContain("boom on click");
});
