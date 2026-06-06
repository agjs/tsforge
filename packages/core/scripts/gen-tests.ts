// Prove the UNTESTED-SPEC pipeline against the live local model, end to end:
//   spec (criteria only, no tests)
//     → generateTests: model writes a suite + throwing stub, verified RED
//     → implement loop: model drives the stub to GREEN against its own tests
// If the gate goes green, an untested spec became working, verified code with no
// human-written tests and no flagship model — purely local.
//
// Run:  TSFORGE_SEED=money bun run packages/core/scripts/gen-tests.ts
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseSpec } from "../src/spec";
import { generateTests } from "../src/spec/generate-tests";
import { reviewAndFixSuite } from "../src/spec/review-tests";
import { runSpec } from "../src/loop/run-spec";
import { OpenAICompatibleProvider } from "../src/inference/openai-compatible";
import { renderEvent } from "../src/render/ansi";
import type { ILoopEvent } from "../src/loop/events";

const seed = process.env.TSFORGE_SEED ?? "money";
const evalsRoot = join(import.meta.dir, "..", "..", "..", "evals");
const seedDir = join(evalsRoot, seed);

const provider = new OpenAICompatibleProvider({
  baseUrl: process.env.TSFORGE_BASE_URL ?? "http://192.168.20.107:8000/v1",
  model: process.env.TSFORGE_MODEL ?? "qwen3.6-27b",
  apiKey: process.env.TSFORGE_API_KEY,
  repetitionPenalty:
    process.env.TSFORGE_REPETITION_PENALTY === undefined
      ? undefined
      : Number(process.env.TSFORGE_REPETITION_PENALTY),
});

// OFFLINE teacher: vets the generated suite for unsatisfiable / over-strict /
// ambiguous assertions before it becomes the gate. Point it at a flagship via
// TSFORGE_JUDGE_URL/MODEL/KEY; with no override it falls back to the local model
// (so the step still runs, just weaker). Never a runtime dependency.
const judge = new OpenAICompatibleProvider({
  baseUrl:
    process.env.TSFORGE_JUDGE_URL ??
    process.env.TSFORGE_BASE_URL ??
    "http://192.168.20.107:8000/v1",
  model:
    process.env.TSFORGE_JUDGE_MODEL ??
    process.env.TSFORGE_MODEL ??
    "qwen3.6-27b",
  apiKey: process.env.TSFORGE_JUDGE_KEY ?? process.env.TSFORGE_API_KEY,
});

const specText = await Bun.file(join(seedDir, `${seed}.spec.md`)).text();
const spec = parseSpec(specText);
const task = spec.tasks[0];

if (task === undefined) {
  throw new Error(`spec ${seed} has no tasks`);
}

const implFile = task.files[0];
const testFile = (task.context ?? []).find((f) => f.endsWith(".test.ts"));

if (implFile === undefined || testFile === undefined) {
  throw new Error(
    `spec ${seed} task needs a files: impl and a *.test.ts context`
  );
}

// Fresh workdir, copied from the seed EXCEPT the hand-written test — the spec
// goes in genuinely untested. (The impl isn't in the seed either; the stub
// generation creates it.)
const d = new Date();
const p = (n: number): string => String(n).padStart(2, "0");
const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
const runId = `gentests-${seed}-${stamp}`;
const runDir = join(evalsRoot, runId);

await mkdir(runDir, { recursive: true });

for (const file of await readdir(seedDir)) {
  if (file === testFile) {
    continue;
  }

  await Bun.write(join(runDir, file), Bun.file(join(seedDir, file)));
}

const onEvent = (e: ILoopEvent): void => {
  process.stdout.write(renderEvent(e, { color: true }));
};

// Phase 1 — generate tests + stub from criteria, verified RED.
process.stdout.write(
  `\n=== phase 1: generate tests for ${seed} → ${testFile} ===\n`
);

const gen = await generateTests(provider, runDir, {
  testFile,
  implFile,
  goal: spec.title,
  criteria: specText,
  maxAttempts: 3,
  onEvent,
});

process.stdout.write(
  `\ntests: ${gen.ok ? "RED & runnable" : "FAILED to produce"} · ${gen.testCount} tests · ${gen.attempts} attempt(s)\n`
);

if (!gen.ok) {
  process.stdout.write(`\nstopping: could not generate a real suite.\n`);
  process.exit(1);
}

// Phase 1.5 — OFFLINE teacher review: catch unsatisfiable / over-strict /
// ambiguous assertions before they become the gate. Corrections are re-verified
// RED (reverted if they break it), so this can only ever hand phase 2 a sound
// suite.
process.stdout.write(`\n=== phase 1.5: review generated tests (offline) ===\n`);

const review = await reviewAndFixSuite(judge, runDir, {
  testFile,
  implFile,
  goal: spec.title,
  criteria: specText,
  onEvent,
});

process.stdout.write(
  `\nreview: ${review.findings.length} finding(s), correction ${review.applied ? "applied" : "not applied"}\n`
);

// Phase 2 — drive the stub to green against the model's own generated tests.
process.stdout.write(
  `\n=== phase 2: implement ${seed} against the generated tests ===\n`
);

const result = await runSpec(spec, runDir, provider, { onEvent });

process.stdout.write(
  `\nimplement: ${result.status === "done" ? "GREEN" : "blocked"}\n`
);
process.stdout.write(`\nrun dir → ${runDir}\n`);
