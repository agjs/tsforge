// Live OpenRouter smoke test for the image capabilities. Reads your real
// ~/.tsforge/models.json + $OPENROUTER_API_KEY, then does one real vision call
// and one real image-generation call. Run in a shell where the key is set:
//   OPENROUTER_API_KEY=... bun scripts/live-image-smoke.ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCapabilityModel,
  resolveApiKey,
  type IModelEntry,
} from "../packages/core/src/models-config";
import { describeImage } from "../packages/core/src/inference/vision";
import { generateImage, saveGeneratedImages } from "../packages/core/src/inference/image-gen";
import type { IOpenAICompatibleConfig } from "../packages/core/src/inference";

// 1x1 red PNG (base64, no prefix)
const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function cfgOf(entry: IModelEntry): IOpenAICompatibleConfig {
  return {
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: resolveApiKey(entry),
    ...(entry.extraHeaders === undefined
      ? {}
      : { extraHeaders: entry.extraHeaders }),
  };
}

const vision = await resolveCapabilityModel("vision");
const image = await resolveCapabilityModel("imageGen");

console.log("vision  →", vision ? `${vision.name} (${vision.entry.model})` : "NOT CONFIGURED");
console.log("imageGen→", image ? `${image.name} (${image.entry.model})` : "NOT CONFIGURED");

if (vision === null || image === null) {
  console.log("\nFAIL: a capability didn't resolve — check ~/.tsforge/models.json capabilities block.");
  process.exit(1);
}
if (resolveApiKey(vision.entry) === undefined) {
  console.log("\nFAIL: no API key — is OPENROUTER_API_KEY exported in this shell?");
  process.exit(1);
}

console.log("\n[1/2] vision: describing a 1x1 red pixel…");
const desc = await describeImage(cfgOf(vision.entry), {
  prompt: "What color is this image? Answer in one word.",
  images: [{ base64: RED_PNG, mimeType: "image/png" }],
});
console.log("  ← reply:", JSON.stringify(desc.slice(0, 200)));

console.log("\n[2/2] image-gen: generating 'a small red circle on a white background'…");
const imgs = await generateImage(cfgOf(image.entry), {
  prompt: "a small red circle on a white background, minimal, flat",
  api: image.entry.imageApi ?? "chat-modalities",
});
const dir = await mkdtemp(join(tmpdir(), "tsforge-live-"));
const paths = await saveGeneratedImages(imgs, dir, "smoke");
console.log(`  ← got ${imgs.length} image(s), ${imgs[0]?.bytes.length ?? 0} bytes, saved: ${paths[0]}`);

const okPng = imgs[0] !== undefined && imgs[0].bytes.length > 100;
console.log(okPng ? "\n==== LIVE PASS — both capabilities work against OpenRouter ====" : "\n==== FAIL: no image bytes returned ====");
process.exit(okPng ? 0 : 1);
