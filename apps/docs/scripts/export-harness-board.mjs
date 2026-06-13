#!/usr/bin/env bun
/**
 * Export harness board assets for OG/social and static SVG linking.
 *
 * Usage (from apps/docs):
 *   bun run build && bun scripts/export-harness-board.mjs
 *
 * Writes:
 *   public/og-harness-board.png  (1200×630)
 *   public/harness-board.svg       (dark-theme standalone)
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(__dirname, "..");
const publicDir = path.join(docsRoot, "public");
const previewPort = 4329;
const previewUrl = `http://127.0.0.1:${previewPort}/og/harness-board`;

function waitForServer(url, timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) {
          resolve(undefined);
          return;
        }
      } catch {
        // server not ready
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Preview server did not start within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 400);
    };
    tick();
  });
}

function startPreview() {
  return spawn("bun", ["run", "preview", "--", "--port", String(previewPort), "--host", "127.0.0.1"], {
    cwd: docsRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
}

async function exportAssets() {
  await mkdir(publicDir, { recursive: true });

  const preview = startPreview();
  let previewFailed = false;

  preview.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    if (text.toLowerCase().includes("error")) {
      previewFailed = true;
    }
  });

  try {
    await waitForServer(previewUrl);

    const browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 2,
    });

    await page.goto(previewUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(".tf-harness-board__svg");

    const pngPath = path.join(publicDir, "og-harness-board.png");
    await page.screenshot({ path: pngPath, type: "png", fullPage: false });

    const svgMarkup = await page.evaluate(() => {
      const svg = document.querySelector(".tf-harness-board__svg");
      return svg ? svg.outerHTML : "";
    });

    await browser.close();

    if (!svgMarkup) {
      throw new Error("Could not extract harness board SVG from OG page");
    }

    const svgPath = path.join(publicDir, "harness-board.svg");
    const standaloneSvg = wrapStandaloneSvg(svgMarkup);
    await writeFile(svgPath, standaloneSvg, "utf8");

    // Also produce a normalized 1200×630 PNG via sharp (consistent file size)
    const normalizedPng = await sharp(pngPath)
      .resize(1200, 630, { fit: "cover", position: "centre" })
      .png()
      .toBuffer();
    await writeFile(pngPath, normalizedPng);

    console.log(`Wrote ${pngPath}`);
    console.log(`Wrote ${svgPath}`);
  } finally {
    preview.kill("SIGTERM");
    if (previewFailed) {
      console.warn("Preview process reported errors — verify output manually.");
    }
  }
}

/** Inline dark-theme styles so public SVG renders without site CSS. */
function wrapStandaloneSvg(innerSvg) {
  const styles = `
    .tf-board-harness-bg { stroke: rgba(96,165,250,0.55); fill: none; }
    .tf-board-boundary-label { font-family: Inter, ui-sans-serif, sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.22em; fill: #93c5fd; }
    .tf-board-trace-stop-a { stop-color: #3b82f6; }
    .tf-board-trace-stop-b { stop-color: #38bdf8; }
    .tf-board-node-bg { fill: rgba(18,20,28,0.92); stroke: rgba(96,165,250,0.38); stroke-width: 1.2; }
    .tf-board-node-title { font-family: Inter, ui-sans-serif, sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; fill: #e8ecf5; }
    .tf-board-node-sub { font-family: ui-monospace, Menlo, monospace; font-size: 7.5px; fill: #94a3b8; }
    .tf-board-icon-stroke { stroke: #93c5fd; fill: none; }
    .tf-board-icon-fill { fill: rgba(59,130,246,0.35); stroke: none; }
    .tf-board-gate-check { stroke: #4ade80; fill: none; }
    .tf-board-model-panel { fill: rgba(13,16,24,0.94); stroke: rgba(56,189,248,0.55); stroke-width: 1.4; }
    .tf-board-heatsink { fill: rgba(56,189,248,0.22); stroke: rgba(56,189,248,0.65); }
    .tf-board-heatsink-fin, .tf-board-pin { stroke: rgba(56,189,248,0.55); stroke-width: 1; fill: none; }
    .tf-board-model-chip { fill: rgba(56,189,248,0.28); stroke: #38bdf8; stroke-width: 1.4; }
    .tf-board-model-title { font-family: Inter, ui-sans-serif, sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.12em; fill: #e8ecf5; }
    .tf-board-model-sub { font-family: ui-monospace, Menlo, monospace; font-size: 8.5px; fill: #94a3b8; }
    .tf-board-traces { stroke: url(#tf-board-trace); }
  `;

  const cleaned = innerSvg.replace(/\sclass="tf-harness-board__svg[^"]*"/, "");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 820 680" role="img" aria-label="tsforge harness board">
  <defs><style type="text/css"><![CDATA[${styles}]]></style></defs>
  ${cleaned.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}
</svg>
`;
}

exportAssets().catch((err) => {
  console.error(err);
  process.exit(1);
});
