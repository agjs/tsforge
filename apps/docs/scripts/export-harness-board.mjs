#!/usr/bin/env bun
/**
 * Export OG social preview from the harness board illustration.
 *
 * Usage (from apps/docs):
 *   bun scripts/export-harness-board.mjs
 *
 * Requires public/harness-board.png (source illustration).
 * Writes public/og-harness-board.png (1200×630).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(__dirname, "..");
const source = path.join(docsRoot, "public", "harness-board.png");
const target = path.join(docsRoot, "public", "og-harness-board.png");

await sharp(source)
  .resize(1200, 630, { fit: "cover", position: "centre" })
  .png()
  .toFile(target);

console.log(`Wrote ${target}`);
