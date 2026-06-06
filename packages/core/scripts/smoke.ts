// Manual smoke check against a live local model. Not part of the test suite.
// Run: bun run packages/core/scripts/smoke.ts
import { OpenAICompatibleProvider } from "../src/inference";

const p = new OpenAICompatibleProvider({
  baseUrl: process.env.TSFORGE_BASE_URL ?? "http://192.168.20.107:8000/v1",
  model: process.env.TSFORGE_MODEL ?? "qwen3.6-35b-a3b",
});

const r = await p.complete(
  [{ role: "user", content: "Reply with exactly: pong" }],
  {
    temperature: 0,
  }
);

console.log("content:", JSON.stringify(r.content));
console.log("toolCalls:", JSON.stringify(r.toolCalls));
