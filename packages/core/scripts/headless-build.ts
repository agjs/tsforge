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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
import { OpenAICompatibleProvider, PROVIDER_LIMITS } from "../src/inference";
import { resolveActiveModel, resolveApiKey } from "../src/models-config";
import { Session, LOOP_LIMITS, type Reporter } from "../src/loop";
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
  /** Declared entities (catalog builds) — the coverage gate enforces each has UI;
   *  empty for ad-hoc prompts (no enforced entity list). */
  readonly entities: readonly string[];
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

    return {
      prompt: buildBenchmarkPrompt(app),
      label: app.slug,
      tailStart: 4,
      entities: app.entities,
    };
  }

  const prompt = process.argv[2];

  if (prompt === undefined || prompt.length === 0) {
    return undefined;
  }

  return { prompt, label: "adhoc", tailStart: 3, entities: [] };
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

/**
 * Plan mode (headless): run the design phase, write the model's build plan to
 * `plan.md` in the run dir, then proceed to implement — headless never blocks for
 * approval (interactive plan mode does the human review). The plan.md is the
 * reviewable artifact: entities, routes, what "done" means, modeling decisions.
 */
async function runPlanned(
  session: Session,
  prompt: string,
  framework: WebFramework,
  dir: string
): Promise<Awaited<ReturnType<Session["buildStaged"]>>> {
  const designed = await session.designBuild(
    prompt,
    {},
    buildWebTypeGate(framework).command
  );

  if (designed.status === "interrupted") {
    return designed;
  }

  const plan = await session.generatePlan();
  const planPath = join(dir, "plan.md");

  writeFileSync(planPath, `${plan}\n`);
  process.stdout.write(`\n📋 plan → ${planPath}\n`);

  return session.implementBuild("", {});
}

async function main(): Promise<void> {
  // `--plan` (plan mode): after the design phase, write the model's build plan to
  // plan.md and proceed (headless never blocks for approval). Strip it before any
  // positional-arg logic so it can sit anywhere on the command line.
  const planMode = process.argv.includes("--plan");

  if (planMode) {
    process.argv = process.argv.filter((a) => a !== "--plan");
  }

  const request = resolveRequest();

  if (request === undefined) {
    process.stderr.write(
      'usage: headless-build.ts "<prompt>" [react|vanilla] [dir]\n' +
        "   or: headless-build.ts --app <slug|index> [react|vanilla] [dir]\n"
    );
    process.exit(2);
  }

  const { prompt, label, tailStart, entities } = request;
  const framework: WebFramework =
    process.argv[tailStart] === "vanilla" ? "vanilla" : "react";
  // The model comes from the registry (~/.tsforge/models.json) unless TSFORGE_*
  // env overrides it — so a catalog run can target a cloud flagship by editing the
  // registry's `active` (or setting env), no code change.
  const { entry } = await resolveActiveModel();
  const model = entry.model;
  const envWindow = Number(process.env.TSFORGE_CONTEXT_WINDOW);
  const contextWindow =
    entry.contextWindow ??
    (Number.isFinite(envWindow) && envWindow > 0 ? envWindow : 262_144);

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
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: resolveApiKey(entry),
    maxTokens: entry.maxTokens ?? PROVIDER_LIMITS.maxTokens,
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
    // For catalog builds, APPEND an entity-coverage check to the gate: the app
    // cannot go green until every declared entity has real UI (not just types) —
    // so the model can't satisfice on a subset (4-of-8 entities greened before).
    accept:
      entities.length > 0
        ? `${buildWebGate(framework).command} && bun "${join(import.meta.dir, "coverage-check.ts")}" "${dir}" ${entities
            .map((e) => JSON.stringify(e))
            .join(" ")}`
        : buildWebGate(framework).command,
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
    // hospital-scheduling hit an 80-turn cap (→ 130). Then the ENTITY-COVERAGE gate
    // (cycle-31) raised the bar again: the model can no longer satisfice on 4 of 8
    // entities — it must build ALL of them. A fast flagship (deepseek) hit the 130
    // phase-2 cap while GENUINELY converging on the full 8 (it had built 7 of 8's
    // routes, coverage shrinking 4→1). A complete 8-entity app is more than 130
    // turns of work → 180 so the now-mandatory full build has room to finish.
    maxTurns: LOOP_LIMITS.webMaxTurns,
    report,
  });

  const result = planMode
    ? await runPlanned(session, prompt, framework, dir)
    : await session.buildStaged(
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
