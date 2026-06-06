// Eval sweep: run a seed spec N times across temperature variants, score, tabulate.
// Run:  TSFORGE_SEED=money TSFORGE_TEMPS=0,0.5 TSFORGE_REPEATS=3 bun run packages/core/scripts/sweep.ts
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseSpec } from "../src/spec";
import { runSpec, qualityRepair } from "../src/loop";
import { modelAgent } from "../src/agent";
import { OpenAICompatibleProvider, PROVIDER_DEFAULTS } from "../src/inference";
import { summarize, type IRunRecord } from "../src/eval";
import { renderEvent } from "../src/render";
import type { ILoopEvent } from "../src/loop";

const seed = process.env.TSFORGE_SEED ?? "todo";
const temps = (process.env.TSFORGE_TEMPS ?? "0,0.5")
  .split(",")
  .map((t) => Number(t.trim()));
const repeats = Number(process.env.TSFORGE_REPEATS ?? "3");
// Default quiet (batch). Set TSFORGE_STREAM=1 to watch the model live.
const stream = process.env.TSFORGE_STREAM === "1";
const qualityTarget = Number(process.env.TSFORGE_QUALITY_TARGET ?? "5");
const qualityAttempts = Number(process.env.TSFORGE_QUALITY_ATTEMPTS ?? "2");

const evalsRoot = join(import.meta.dir, "..", "..", "..", "evals");
const seedDir = join(evalsRoot, seed);
// Recursive so nested-directory apps (e.g. a React app under `src/`) copy whole;
// flat single-dir evals are unaffected (recursive readdir returns the same list).
const seedFiles = await readdir(seedDir, { recursive: true });

const provider = new OpenAICompatibleProvider({
  baseUrl: process.env.TSFORGE_BASE_URL ?? PROVIDER_DEFAULTS.baseUrl,
  model: process.env.TSFORGE_MODEL ?? PROVIDER_DEFAULTS.model,
  apiKey: process.env.TSFORGE_API_KEY,
  // Thinking tokens count against the limit, so give reasoning + code room.
  maxTokens: Number(process.env.TSFORGE_MAX_TOKENS ?? "16384"),
  // Opt-in only: a repetition penalty breaks rare temp-0 loops but DEGRADES
  // algorithmic code (it made `money` write unsafe/any code that failed the
  // strict gate). Default off; enable via env if a target genuinely loops.
  repetitionPenalty:
    process.env.TSFORGE_REPETITION_PENALTY === undefined
      ? undefined
      : Number(process.env.TSFORGE_REPETITION_PENALTY),
});

// The judge scores quality. Point it at a flagship via TSFORGE_JUDGE_URL/MODEL
// (+ TSFORGE_JUDGE_KEY) to measure the gap; defaults to the model judging itself.
const judgeProvider = new OpenAICompatibleProvider({
  baseUrl:
    process.env.TSFORGE_JUDGE_URL ??
    process.env.TSFORGE_BASE_URL ??
    PROVIDER_DEFAULTS.baseUrl,
  model:
    process.env.TSFORGE_JUDGE_MODEL ??
    process.env.TSFORGE_MODEL ??
    PROVIDER_DEFAULTS.model,
  apiKey: process.env.TSFORGE_JUDGE_KEY ?? process.env.TSFORGE_API_KEY,
});

/** Sortable timestamp `YYYYMMDD-HHMMSS` so run dirs sort newest-last by name. */
function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");

  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const records: IRunRecord[] = [];

for (const temp of temps) {
  for (let i = 0; i < repeats; i += 1) {
    const runId = `${seed}-t${temp}-${stamp()}-${i + 1}`;
    const runDir = join(evalsRoot, runId);

    // One run's failure (e.g. a request timing out) must not abort the sweep —
    // record it as a blocked run and carry on, so a long batch is resilient.
    try {
      await runOne(runId, runDir, temp, i);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      records.push({ label: `temp=${temp}`, passed: false, cycles: 0, ms: 0 });
      process.stdout.write(
        `  ${seed} temp=${temp} #${i + 1}: ERRORED (${message}) → ${runId}\n`
      );
    }
  }
}

async function runOne(
  runId: string,
  runDir: string,
  temp: number,
  i: number
): Promise<void> {
  await mkdir(runDir, { recursive: true });

  for (const file of seedFiles) {
    const src = join(seedDir, file);

    // recursive readdir yields directory entries too — skip them (Bun.write
    // creates parent dirs for files automatically).
    if ((await stat(src)).isDirectory()) {
      continue;
    }

    await Bun.write(join(runDir, file), Bun.file(src));
  }

  const spec = parseSpec(
    await Bun.file(join(runDir, `${seed}.spec.md`)).text()
  );

  // Start red: in `scratch` mode, remove editable files so the model
  // regenerates them. In `existing` mode the project is KEPT (work-on-existing:
  // RED comes from a failing test / goal; the model edits in place).
  if (spec.mode !== "existing") {
    for (const task of spec.tasks) {
      for (const f of task.files) {
        await rm(join(runDir, f), { force: true });
      }
    }
  }

  // Every run gets a full transcript at <runDir>/run.log; stream to the
  // terminal too when TSFORGE_STREAM=1.
  const log = Bun.file(join(runDir, "run.log")).writer();

  const onEvent = (e: ILoopEvent): void => {
    void log.write(renderEvent(e, { color: false }));
    // Flush per event — otherwise Bun's FileSink buffers and `tail -f` shows
    // nothing until the run ends. The log must be live.
    void log.flush();

    if (stream) {
      process.stdout.write(renderEvent(e, { color: true }));
    }
  };

  const agent = modelAgent(provider, {
    temperature: temp,
    ...(process.env.TSFORGE_THINKING_BUDGET === undefined
      ? {}
      : { thinkingTokenBudget: Number(process.env.TSFORGE_THINKING_BUDGET) }),
  });
  const started = performance.now();
  const result = await runSpec(spec, runDir, provider, {
    onEvent,
    temperature: temp,
    // Cap reasoning per call to trim turn time — A/B the sweet spot via env.
    ...(process.env.TSFORGE_THINKING_BUDGET === undefined
      ? {}
      : { thinkingTokenBudget: Number(process.env.TSFORGE_THINKING_BUDGET) }),
  });

  const ms = Math.round(performance.now() - started);
  const cycles = result.results.reduce((acc, r) => acc + r.cycles, 0);
  const passed = result.status === "done";

  // Once green, drive QUALITY up: judge → improve-per-critique → re-judge.
  let quality: number | undefined;
  let judgeNotes = "";
  const firstTask = spec.tasks[0];

  if (passed && firstTask !== undefined) {
    const specText = await Bun.file(join(runDir, `${seed}.spec.md`)).text();

    // The judge is a MEASUREMENT, not part of the build. If it fails (e.g. the
    // server times out), the implement result still stands — degrade to
    // "quality unknown" rather than erroring out a successful run.
    try {
      const qr = await qualityRepair(
        firstTask,
        runDir,
        agent,
        judgeProvider,
        { goal: spec.title, criteria: specText },
        { target: qualityTarget, maxAttempts: qualityAttempts, onEvent }
      );

      quality = qr.quality;
      judgeNotes = qr.notes;
    } catch (err) {
      judgeNotes = `judge unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  await log.end();

  // Structured per-run artifact for comparison alongside run.log + the code.
  await Bun.write(
    join(runDir, "result.json"),
    JSON.stringify(
      {
        seed,
        runId,
        temperature: temp,
        status: result.status,
        cycles,
        ms,
        quality,
        judgeNotes,
        tasks: result.results,
      },
      null,
      2
    )
  );

  const edits = result.results.reduce((a, r) => a + (r.edits ?? 0), 0);
  const regressions = result.results.reduce(
    (a, r) => a + (r.regressions ?? 0),
    0
  );

  records.push({ label: `temp=${temp}`, passed, cycles, ms, quality });
  process.stdout.write(
    `  ${seed} temp=${temp} #${i + 1}: ${passed ? "done" : "blocked"} (${cycles} cyc, ${edits} edits, ${regressions} regress, ${ms}ms${quality === undefined ? "" : `, Q${quality}/5`}) → ${runId}\n`
  );
}

const summaries = summarize(records);

process.stdout.write(`\n=== sweep: ${seed} (${repeats} runs/variant) ===\n`);

for (const s of summaries) {
  process.stdout.write(
    `${s.label.padEnd(10)}  pass ${Math.round(s.passRate * 100)}% (${s.passed}/${s.runs})  Q ${s.avgQuality.toFixed(1)}/5  avg ${s.avgCycles.toFixed(1)} cyc  ${Math.round(s.avgMs)}ms\n`
  );
}

const outPath = join(evalsRoot, `sweep-${seed}-${stamp()}.json`);

await Bun.write(
  outPath,
  JSON.stringify({ seed, temps, repeats, records, summaries }, null, 2)
);
process.stdout.write(`\nsaved ${outPath}\n`);
