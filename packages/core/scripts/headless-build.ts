// Run a from-scratch web build against the LIVE model, NON-interactively — the
// missing piece for an autonomous improve-the-harness loop. Each run gets its OWN
// dir under evals/runs/ (node_modules symlinked), runs the staged build with
// the real web gate, streams progress, and writes a --log-style JSONL so
// `cli-metrics.ts` can score it (repair turns, tokens, what slipped, salvaged).
//
// Run:  bun run packages/core/scripts/headless-build.ts "build a kanban board" [react|vanilla] [dir]
//   or:  bun run packages/core/scripts/headless-build.ts --app <slug|index> [react|vanilla] [dir]
//        (--app builds a FIXED benchmark-catalog domain with the full generation spec)
//   then: bun run packages/core/scripts/cli-metrics.ts
import { appendFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  buildWebFix,
  buildWebGate,
  buildWebTypeGate,
  buildWebTscCheck,
  installWebDeps,
  makeFileLinter,
  scaffoldWeb,
  webGuidance,
} from "../src/detect-gate";
import {
  OpenAICompatibleProvider,
  PROVIDER_DEFAULTS,
  PROVIDER_LIMITS,
} from "../src/inference";
import { Session, type Reporter } from "../src/loop";
import { renderEvent } from "../src/render";
import { logsDir } from "../src/session-store";
import type { WebFramework } from "../src/web-templates";
import {
  BENCHMARK_CATALOG,
  buildBenchmarkPrompt,
  findBenchmarkApp,
} from "./benchmark-catalog";

interface IBuildRequest {
  /** The full task prompt handed to the model. */
  readonly prompt: string;
  /** A short slug for naming the snapshot (the benchmark slug, or "adhoc"). */
  readonly label: string;
  /** argv index where [framework] [dir] start (shifts when --app is used). */
  readonly tailStart: number;
}

/** Resolve the build request from argv: either a benchmark --app or a free prompt. */
function resolveRequest(): IBuildRequest | undefined {
  if (process.argv[2] === "--app") {
    const selector = process.argv[3] ?? "";
    const app = findBenchmarkApp(selector);

    if (app === undefined) {
      const list = BENCHMARK_CATALOG.map(
        (a, i) => `  ${String(i + 1)}. ${a.slug} — ${a.name}`
      ).join("\n");

      process.stderr.write(
        `unknown benchmark "${selector}". catalog:\n${list}\n`
      );

      return undefined;
    }

    return { prompt: buildBenchmarkPrompt(app), label: app.slug, tailStart: 4 };
  }

  const prompt = process.argv[2];

  if (prompt === undefined || prompt.length === 0) {
    return undefined;
  }

  return { prompt, label: "adhoc", tailStart: 3 };
}

/** Tee progress to the terminal, a human-readable agent.log IN THE RUN DIR (so you
 *  can `tail -f <rundir>/agent.log` right next to the code), and a JSONL log for
 *  cli-metrics. */
function makeReporter(logFile: string, agentLog: string): Reporter {
  return (event) => {
    process.stdout.write(renderEvent(event, { color: true }));
    appendFileSync(agentLog, renderEvent(event, { color: false }));
    appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), ...event })}\n`);
  };
}

/** A canonical scaffold whose node_modules we install ONCE and symlink into every
 *  run dir — so each build gets a fresh isolated directory without a per-run
 *  `bun install`. Returns the absolute node_modules path to symlink. */
async function ensureDepsCache(
  evalsRoot: string,
  framework: WebFramework
): Promise<string> {
  const cacheDir = join(evalsRoot, `.web-cache-${framework}`);
  const nodeModules = join(cacheDir, "node_modules");

  if (!existsSync(nodeModules)) {
    await scaffoldWeb(cacheDir, framework);
    await installWebDeps(cacheDir);
  }

  return nodeModules;
}

async function main(): Promise<void> {
  const request = resolveRequest();

  if (request === undefined) {
    process.stderr.write(
      'usage: headless-build.ts "<prompt>" [react|vanilla] [dir]\n' +
        "   or: headless-build.ts --app <slug|index> [react|vanilla] [dir]\n"
    );
    process.exit(2);
  }

  const { prompt, label, tailStart } = request;
  const framework: WebFramework =
    process.argv[tailStart] === "vanilla" ? "vanilla" : "react";
  const model = process.env.TSFORGE_MODEL ?? PROVIDER_DEFAULTS.model;
  const envWindow = Number(process.env.TSFORGE_CONTEXT_WINDOW);
  const contextWindow =
    Number.isFinite(envWindow) && envWindow > 0 ? envWindow : 262_144;

  // EACH RUN GETS ITS OWN DIRECTORY: evals/runs/<timestamp>-<label>/ — so you
  // always know exactly where this build's code is, and prior runs are never
  // clobbered. Override with the trailing arg. node_modules is symlinked from a
  // one-time install cache, so a fresh dir doesn't mean a fresh `bun install`.
  const evalsRoot = join(import.meta.dir, "..", "..", "..", "evals");
  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\..+$/, "");
  const dir =
    process.argv[tailStart + 1] ?? join(evalsRoot, "runs", `${stamp}-${label}`);

  mkdirSync(dir, { recursive: true });
  await scaffoldWeb(dir, framework);

  if (!existsSync(join(dir, "node_modules"))) {
    const cache = await ensureDepsCache(evalsRoot, framework);

    symlinkSync(cache, join(dir, "node_modules"), "dir");
  }

  const agentLog = join(dir, "agent.log");
  const logFile = join(logsDir(), `${stamp}-headless.jsonl`);

  mkdirSync(logsDir(), { recursive: true });

  const provider = new OpenAICompatibleProvider({
    baseUrl: process.env.TSFORGE_BASE_URL ?? PROVIDER_DEFAULTS.baseUrl,
    model,
    apiKey: process.env.TSFORGE_API_KEY,
    maxTokens: PROVIDER_LIMITS.maxTokens,
  });

  const report = makeReporter(logFile, agentLog);

  process.stdout.write(
    `\n📁 BUILD DIR: ${dir}\n` +
      `   follow it:  tail -f ${agentLog}\n` +
      `   ${framework} scaffold ready (deps symlinked)\n\n`
  );
  report({
    kind: "start",
    task: "session",
    message: `model ${model} · context window ${contextWindow}`,
    model,
    contextWindow,
  });

  const session = await Session.create({
    provider,
    cwd: dir,
    files: ["**/*"],
    accept: buildWebGate(framework).command,
    fix: buildWebFix(framework),
    incrementalCheck: buildWebTscCheck(),
    // WRITE-TIME LINT: surface the gate's eslint moat rules (no-as, I-prefix,
    // prefer-template) on each file the instant it's written — tsc can't see them,
    // so without this they pile up unseen until the gate (a run log showed 12 `as`
    // casts accumulating that way). cwd = the run dir so vendored ignores resolve.
    lintFile: makeFileLinter(framework, dir),
    // Offer the themed-UI-primitives tool so the model generates button/card/input/
    // etc. (tested, theme-coherent) instead of re-authoring them every build.
    scaffoldUi: framework === "react",
    guidance: webGuidance(framework),
    contextWindow,
    // ADAPTIVE THINKING (measured ~80% of build time is REPAIR): default thinking
    // OFF for fast creation; the Session flips it ON automatically while errors are
    // outstanding (interim/gate RED) so repair CONVERGES instead of oscillating to
    // the turn cap (which thinking-off-everywhere did). Best of both: fast create +
    // convergent repair, and no 5-min pre-write spiral (thinking only on repair).
    enableThinking: false,
    // A from-scratch multi-domain app needs more than the 40 default. The full
    // benchmark spec (8+ entities, 40-60 files) needs more still: pm-platform AND
    // hospital-scheduling both hit an 80-turn cap while genuinely converging —
    // hospital was build-passing + ONE lint error from green at turn 70/80. Bumped
    // to 130 so these big apps have room to finish, not just to get close.
    maxTurns: 130,
    report,
  });

  const result = await session.buildStaged(
    prompt,
    {},
    buildWebTypeGate(framework).command
  );

  // The run dir IS the persistent, runnable artifact (per-run, never clobbered):
  // `cd <dir> && bun run dev` (node_modules is symlinked). No separate snapshot.
  process.stdout.write(
    `\n[${result.status} · ${result.turns} turn(s)]\n` +
      `📁 code:      ${dir}\n` +
      `   agent log: ${agentLog}\n` +
      `   jsonl:     ${logFile}\n` +
      "   score it:  bun run packages/core/scripts/cli-metrics.ts\n"
  );
  process.exit(result.status === "done" ? 0 : 1);
}

await main();
