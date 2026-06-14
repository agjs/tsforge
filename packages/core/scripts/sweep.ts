// Eval sweep: run seed spec(s) N times across temperature + feature flag variants, score, tabulate.
// Run:  TSFORGE_SEED=money TSFORGE_TEMPS=0,0.5 TSFORGE_REPEATS=3 bun run packages/core/scripts/sweep.ts
// TSFORGE_SEED accepts a comma-separated list (e.g. slugify,debounce,rate-limit) — each seed
// runs the full variant matrix and gets its own report + saved JSON.
// A/B feature variants:
//   TSFORGE_FEATURE_VARIANTS=ttsr,hashline (sweep across feature toggles)
//   Each variant is dim=on|off (e.g. ttsr=on×hashline=off) creating a cartesian product.
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseSpec } from "../src/spec";
import { buildGate, buildCoreFix } from "../src/detect-gate";
import { runSpec, qualityRepair } from "../src/loop";
import { modelAgent } from "../src/agent";
import { OpenAICompatibleProvider } from "../src/inference";
import { resolveActiveModel, resolveApiKey } from "../src/models-config";
import { providerConfig } from "../src/cli";
import {
  summarize,
  classifyRun,
  countTaskLoc,
  renderSweepReportMarkdown,
  buildSweepReport,
  type IRunRecord,
} from "../src/eval";
import { renderEvent } from "../src/render";
import type { ILoopEvent } from "../src/loop";

const seeds = (process.env.TSFORGE_SEED ?? "todo")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const temps = (process.env.TSFORGE_TEMPS ?? "0,0.5")
  .split(",")
  .map((t) => Number(t.trim()));
const repeats = Number(process.env.TSFORGE_REPEATS ?? "3");
// Default quiet (batch). Set TSFORGE_STREAM=1 to watch the model live.
const stream = process.env.TSFORGE_STREAM === "1";
const qualityTarget = Number(process.env.TSFORGE_QUALITY_TARGET ?? "5");
const qualityAttempts = Number(process.env.TSFORGE_QUALITY_ATTEMPTS ?? "2");

/** Feature variants to sweep: a cartesian product of feature dimensions.
 *  Example: `ttsr,hashline` → generates [ttsr=on×hashline=on, ttsr=on×hashline=off,
 *  ttsr=off×hashline=on, ttsr=off×hashline=off]. Each dimension toggles via env var. */
type IFeatureVariant = Record<string, string>;

function parseFeatureVariants(): IFeatureVariant[] {
  const featureDims = (process.env.TSFORGE_FEATURE_VARIANTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (featureDims.length === 0) {
    return [{}]; // No features to sweep → one baseline variant
  }

  // Cartesian product: each dimension has 2 states (on=1, off=0).
  const variants: IFeatureVariant[] = [];
  const numVariants = Math.pow(2, featureDims.length);

  for (let i = 0; i < numVariants; i++) {
    const variant: IFeatureVariant = {};

    for (let d = 0; d < featureDims.length; d++) {
      const dim = featureDims[d];

      if (dim !== undefined) {
        const state = (i >> d) & 1; // Bit d of i → dimension d state

        variant[dim] = state === 1 ? "1" : "0";
      }
    }

    variants.push(variant);
  }

  return variants;
}

/** Map feature variant to env vars. Each feature dim maps to a TSFORGE_* var. */
function variantToEnvVars(variant: IFeatureVariant): Record<string, string> {
  const envVars: Record<string, string> = {};

  for (const [dim, state] of Object.entries(variant)) {
    if (dim === "ttsr") {
      envVars.TSFORGE_TTSR = state === "1" ? "1" : "0";
    } else if (dim === "hashline") {
      envVars.TSFORGE_HASHLINE = state === "1" ? "1" : "0";
    } else if (dim === "lsp_write_feedback") {
      envVars.TSFORGE_LSP_WRITE_FEEDBACK = state === "1" ? "1" : "0";
    }
    // else: unknown dimension, skip
  }

  return envVars;
}

/** Variant label for logging: e.g. "ttsr=on,hashline=off". */
function variantLabel(variant: IFeatureVariant): string {
  const parts = Object.entries(variant)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dim, state]) => `${dim}=${state === "1" ? "on" : "off"}`);

  return parts.length > 0 ? parts.join(",") : "baseline";
}

const featureVariants = parseFeatureVariants();

const evalsRoot = join(import.meta.dir, "..", "..", "..", "evals");

/** Resolve a seed's directory: prefer a local working seed (evals/<seed>); fall
 *  back to the committed corpus (evals/corpus/<seed>) so checked-in seeds run with
 *  no manual copy step. */
async function resolveSeedDir(seed: string): Promise<string> {
  const local = join(evalsRoot, seed);

  return (await Bun.file(join(local, `${seed}.spec.md`)).exists())
    ? local
    : join(evalsRoot, "corpus", seed);
}

// Resolve the model the same way the CLI does: explicit TSFORGE_* env wins, else
// the active entry from ~/.tsforge/models.json. (Previously this hardcoded the
// localhost default and ignored the registry, so a sweep silently dialed an
// unreachable endpoint and hung with an empty run.log.)
const { entry: activeModel } = await resolveActiveModel();

// Build the wire config the SAME way the CLI does (`providerConfig`), so the
// sweep inherits the active entry's provider dialect — `reasoning`,
// `reasoningEffort`, `extraBody`, `extraHeaders`. Hand-rolling the config here
// dropped those fields, so a DeepSeek sweep sent qwen-only params and hit the
// 400s the interactive path already handles. maxTokens still defaults to
// PROVIDER_LIMITS (16384) — thinking tokens count against it, so reasoning +
// code get room. Repetition penalty stays opt-in via TSFORGE_REPETITION_PENALTY.
const provider = new OpenAICompatibleProvider(providerConfig(activeModel));

// The judge scores quality. Point it at a flagship via TSFORGE_JUDGE_URL/MODEL
// (+ TSFORGE_JUDGE_KEY) to measure the gap. When NOT overridden, the active
// model judges itself — reuse its full dialect via providerConfig so a
// self-judge against DeepSeek speaks DeepSeek too. An explicit external judge
// is a plain generic call (its own endpoint, no inherited reasoning dialect).
const judgeOverridden =
  process.env.TSFORGE_JUDGE_URL !== undefined ||
  process.env.TSFORGE_JUDGE_MODEL !== undefined;
const judgeProvider = new OpenAICompatibleProvider(
  judgeOverridden
    ? {
        baseUrl: process.env.TSFORGE_JUDGE_URL ?? activeModel.baseUrl,
        model: process.env.TSFORGE_JUDGE_MODEL ?? activeModel.model,
        apiKey: process.env.TSFORGE_JUDGE_KEY ?? resolveApiKey(activeModel),
      }
    : providerConfig(activeModel)
);

/** Sortable timestamp `YYYYMMDD-HHMMSS` so run dirs sort newest-last by name. */
function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");

  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

for (const seed of seeds) {
  const seedDir = await resolveSeedDir(seed);
  // Recursive so nested-directory apps (e.g. a React app under `src/`) copy whole;
  // flat single-dir evals are unaffected (recursive readdir returns the same list).
  const seedFiles = await readdir(seedDir, { recursive: true });
  const records: IRunRecord[] = [];

  for (const variant of featureVariants) {
    const variantEnv = variantToEnvVars(variant);
    const vLabel = variantLabel(variant);

    for (const temp of temps) {
      for (let i = 0; i < repeats; i += 1) {
        const runId = `${seed}-${vLabel}-t${temp}-${stamp()}-${i + 1}`;
        const runDir = join(evalsRoot, "runs", runId);

        // One run's failure (e.g. a request timing out) must not abort the sweep —
        // record it as a blocked run and carry on, so a long batch is resilient.
        try {
          records.push(
            await runOne(
              seed,
              seedDir,
              seedFiles,
              runId,
              runDir,
              temp,
              i,
              variantEnv
            )
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);

          records.push({
            label: `${vLabel} temp=${temp}`,
            passed: false,
            cycles: 0,
            ms: 0,
          });
          process.stdout.write(
            `  ${seed} ${vLabel} temp=${temp} #${i + 1}: ERRORED (${message}) → ${runId}\n`
          );
        }
      }
    }
  }

  await reportSeed(seed, records);
}

/** Set env vars for a variant, returning a restore function. */
function setVariantEnv(variant: Record<string, string>): () => void {
  const saved: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(variant)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        // Rather than delete, we just don't restore the var.
        // It was undefined before, so it stays undefined.
        continue;
      }

      process.env[key] = value;
    }
  };
}

/** Copy seed files and prepare the run directory. */
async function setupRunDir(
  dir: string,
  seedDir: string,
  seedFiles: string[]
): Promise<void> {
  await mkdir(dir, { recursive: true });

  for (const file of seedFiles) {
    const src = join(seedDir, file);

    if ((await stat(src)).isDirectory()) {
      continue;
    }

    await Bun.write(join(dir, file), Bun.file(src));
  }
}

/** Remove task files in scratch mode (keep in existing mode). */
async function startRed(
  dir: string,
  spec: ReturnType<typeof parseSpec>
): Promise<void> {
  if (spec.mode !== "existing") {
    for (const task of spec.tasks) {
      for (const f of task.files) {
        await rm(join(dir, f), { force: true });
      }
    }
  }
}

async function runOne(
  seed: string,
  seedDir: string,
  seedFiles: string[],
  runId: string,
  runDir: string,
  temp: number,
  i: number,
  variantEnv: Record<string, string> = {}
): Promise<IRunRecord> {
  const restore = setVariantEnv(variantEnv);

  try {
    await setupRunDir(runDir, seedDir, seedFiles);

    const spec = parseSpec(
      await Bun.file(join(runDir, `${seed}.spec.md`)).text()
    );

    await startRed(runDir, spec);

    // Apply tsforge's STRICT FLOOR (bundled tsc-strict + eslint) to the eval
    // gate — the SAME gate the interactive CLI builds. Eval mode otherwise
    // trusts the spec's `accept` verbatim, so an error the tests don't execute
    // (an unguarded index access, an `as any`) slipped through as GREEN. Now
    // every task and the whole-spec verify must clear the strict floor BEFORE
    // its functional tests count.
    // buildCoreFix (eslint --fix + prettier) runs as task.fix before each gate
    // check — same janitor as the interactive CLI — so padding-line, prefer-const,
    // etc. are squashed without model turns.
    const gateCommand = (await buildGate(runDir)).command;
    const fixCommand = buildCoreFix();
    const gatedSpec = {
      ...spec,
      tasks: spec.tasks.map((t) => ({
        ...t,
        fix: fixCommand,
        accept: `${gateCommand} && ${t.accept}`,
      })),
      verify:
        spec.verify.length > 0
          ? `${gateCommand} && ${spec.verify}`
          : gateCommand,
    };

    // Every run gets a full transcript at <runDir>/run.log; stream to the
    // terminal too when TSFORGE_STREAM=1.
    const log = Bun.file(join(runDir, "run.log")).writer();
    // Keep the structured events so a failed run can be classified (WHY it
    // failed), not just counted — fed to classifyRun below.
    const runEvents: ILoopEvent[] = [];

    const onEvent = (e: ILoopEvent): void => {
      runEvents.push(e);
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
    const result = await runSpec(gatedSpec, runDir, provider, {
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

    // LOC is the concision signal the gate can't see — measured post-hoc on the
    // GREEN solution's task files (a failed run has no shipped solution to size).
    let loc: number | undefined;

    if (passed) {
      const taskFiles = spec.tasks.flatMap((t) => t.files);

      loc = (await countTaskLoc(runDir, taskFiles)).totalLoc;
    }

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
    // Include the feature variant so analysis can reconstruct the conditions.
    await Bun.write(
      join(runDir, "result.json"),
      JSON.stringify(
        {
          seed,
          runId,
          temperature: temp,
          features: variantEnv,
          status: result.status,
          cycles,
          ms,
          quality,
          loc,
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

    const vLabel = variantLabel(variantEnv);
    const failureClass = passed
      ? undefined
      : classifyRun(runEvents).failureClass;

    process.stdout.write(
      `  ${seed} ${vLabel} temp=${temp} #${i + 1}: ${passed ? "done" : `blocked[${failureClass ?? "unknown"}]`} (${cycles} cyc, ${edits} edits, ${regressions} regress, ${ms}ms${quality === undefined ? "" : `, Q${quality}/5`}${loc === undefined ? "" : `, ${String(loc)} loc`}) → ${runId}\n`
    );

    return {
      label: `${vLabel} temp=${temp}`,
      passed,
      cycles,
      ms,
      quality,
      ...(loc === undefined ? {} : { loc }),
      ...(failureClass === undefined ? {} : { failureClass }),
    };
  } finally {
    restore();
  }
}

/** Print one seed's per-variant summary + statistical report, and save its JSON. */
async function reportSeed(seed: string, records: IRunRecord[]): Promise<void> {
  const summaries = summarize(records);

  process.stdout.write(`\n=== sweep: ${seed} (${repeats} runs/variant) ===\n`);

  for (const s of summaries) {
    const failures = Object.entries(s.failureClasses)
      .sort(([, a], [, b]) => b - a)
      .map(([cls, n]) => `${cls}×${String(n)}`)
      .join(", ");

    process.stdout.write(
      `${s.label.padEnd(10)}  pass ${Math.round(s.passRate * 100)}% (${s.passed}/${s.runs})  Q ${s.avgQuality.toFixed(1)}/5  ${s.avgLoc.toFixed(1)} loc  avg ${s.avgCycles.toFixed(1)} cyc  ${Math.round(s.avgMs)}ms${failures.length > 0 ? `  [${failures}]` : ""}\n`
    );
  }

  // The statistical report (Wilson CI + z-test vs baseline) now also tabulates a
  // per-variant failure-class breakdown — WHY runs failed, not just how often.
  process.stdout.write(
    `\n${renderSweepReportMarkdown(buildSweepReport(records))}\n`
  );

  const outPath = join(evalsRoot, "runs", `sweep-${seed}-${stamp()}.json`);

  await Bun.write(
    outPath,
    JSON.stringify({ seed, temps, repeats, records, summaries }, null, 2)
  );
  process.stdout.write(`\nsaved ${outPath}\n`);
}
