// Drive the live model through the Todo spec into a fresh, uuid'd run folder
// under /evals (gitignored). Streams to your terminal AND to run.log.
// Run: bun run packages/core/scripts/run-eval-todo.ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseSpec } from "../src/spec";
import { runSpec } from "../src/loop";
import { OpenAICompatibleProvider } from "../src/inference";
import { renderEvent } from "../src/render";

const evalsRoot = join(import.meta.dir, "..", "..", "..", "evals");
const seedDir = join(evalsRoot, "todo");

// One isolated folder per run. Kept at evals/<id> depth so the spec's
// ../../node_modules paths still resolve.
const runId = `todo-${crypto.randomUUID().slice(0, 8)}`;
const runDir = join(evalsRoot, runId);

await mkdir(runDir, { recursive: true });

// Copy the seed (spec, tests, constitution) into the run folder.
for (const file of [
  "todo.spec.md",
  "todo.test.ts",
  "tsconfig.json",
  "eslint.config.js",
]) {
  await Bun.write(join(runDir, file), Bun.file(join(seedDir, file)));
}

const spec = parseSpec(await Bun.file(join(runDir, "todo.spec.md")).text());

const provider = new OpenAICompatibleProvider({
  baseUrl: process.env.TSFORGE_BASE_URL ?? "http://192.168.20.107:8000/v1",
  model: process.env.TSFORGE_MODEL ?? "qwen3.6-27b",
});

// Tee to the terminal (colored) AND run.log (plain).
const log = Bun.file(join(runDir, "run.log")).writer();

const out = (colored: string, plain: string): void => {
  process.stdout.write(colored);
  void log.write(plain);
};

out(`run ${runId}\n`, `run ${runId}\n`);

const result = await runSpec(spec, runDir, provider, {
  onEvent: (e) =>
    out(renderEvent(e, { color: true }), renderEvent(e, { color: false })),
});

const summary = `\n\nspec "${spec.id}" -> ${result.status}\ntasks: ${JSON.stringify(result.results)}\n`;

out(summary, summary);
await log.end();

console.log(`\nFull log + output in: ${runDir}`);
