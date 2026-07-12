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
  makeFileLinter,
  WEB_PACKS,
} from "../src/gate";
import {
  installWebDeps,
  scaffoldWeb,
  webGuidance,
} from "../src/scaffold/web-scaffold";
import { OpenAICompatibleProvider, PROVIDER_LIMITS } from "../src/inference";
import { resolveActiveModel, resolveApiKey } from "../src/models-config";
import { Session, LOOP_LIMITS, type Reporter } from "../src/loop";
import { runBoringstackBuild } from "../src/loop/boringstack/build";
import type { Exec } from "../src/loop/boringstack/exec";
import { detectContextWindow } from "../src/cli/model-setup";
import { loadAgentSpecs } from "../src/config/agent-specs";
import {
  loadTsforgeConfig,
  resolveAgentConcurrency,
} from "../src/config/tsforge-config";
import { makeSpawnAgentFn } from "../src/cli/spawn-runner";
import { renderEvent } from "../src/render";
import { activeOverlay } from "../src/self-harness";
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
    buildWebTypeGate(framework, undefined, dir).command
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

/** A real command runner (Bun.spawn) for BoringStack's generators + gate. Runs on
 *  the host, with DATABASE_URL pointed at the stack's PUBLISHED localhost Postgres
 *  (the in-repo .env targets the compose service name, unreachable from the host). */
const boringstackExec: Exec = async (argv, opts) => {
  const proc = Bun.spawn([...argv], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.TSFORGE_BORINGSTACK_DATABASE_URL ??
        "postgresql://app:app_dev_password@localhost:5432/app",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;

  return { code, stdout, stderr };
};

/** BORINGSTACK full-stack build (opt-in TSFORGE_BORINGSTACK=1). Unlike the web
 *  path this does NOT scaffold — `dir` must already be a booted BoringStack clone
 *  (from `tsforge scaffold --archetype boringstack`). The Session is only the build
 *  HOST (setScope + send); the driver runs BoringStack's own generators + gate. */
async function runBoringstackBranch(
  dir: string,
  prompt: string,
  entry: Awaited<ReturnType<typeof resolveActiveModel>>["entry"],
  contextWindow: number,
  logFileOverride: string | undefined,
  stamp: string
): Promise<void> {
  if (!existsSync(join(dir, "apps", "api"))) {
    process.stderr.write(
      `TSFORGE_BORINGSTACK=1 expects <dir> to be a scaffolded BoringStack clone ` +
        `(apps/api not found in ${dir}). Scaffold it first:\n` +
        `  tsforge scaffold --archetype boringstack --dest ${dir}\n`
    );
    process.exit(2);
  }

  const provider = new OpenAICompatibleProvider({
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: resolveApiKey(entry),
    maxTokens: entry.maxTokens ?? PROVIDER_LIMITS.maxTokens,
    connectRetryMs: 180_000,
  });
  const agentLog = join(dir, "agent.log");
  const logFile = logFileOverride ?? join(logsDir(), `${stamp}-headless.jsonl`);

  mkdirSync(logsDir(), { recursive: true });

  const report = makeReporter(logFile, agentLog);

  process.stdout.write(
    `\n📁 BUILD DIR (boringstack clone): ${dir}\n` +
      `   follow it:  tail -f ${agentLog}\n\n`
  );

  // Run the gate the way a developer does: on disk with deps installed. The
  // scaffold installs deps into the dev-container volumes only, so the host clone
  // needs its own install (idempotent — fast once present). No monorepo workspaces,
  // so install per app + root.
  for (const sub of [".", "apps/api", "apps/ui"]) {
    report({
      kind: "tool",
      task: "boringstack",
      message: `bun install (${sub})`,
    });
    const installed = await boringstackExec(["bun", "install"], {
      cwd: join(dir, sub),
    });

    if (installed.code !== 0) {
      process.stderr.write(
        `bun install failed in ${sub}:\n${installed.stderr}\n`
      );
      process.exit(1);
    }
  }

  const host = await Session.create({
    provider,
    cwd: dir,
    files: ["**/*"],
    contextWindow,
    maxTurns: LOOP_LIMITS.webMaxTurns,
    guidance:
      "You are filling in ONE BoringStack resource at a time. The API resource " +
      "files (schemas/service/types) and its UI feature are already generated and " +
      "wired; edit ONLY the files named in the task, add real domain fields + logic " +
      "(never an `as` cast), and write the required test siblings. Everything else " +
      "is locked.",
    report,
  });

  const result = await runBoringstackBuild({
    cwd: dir,
    goal: prompt,
    host,
    evaluator: provider,
    exec: boringstackExec,
    onEvent: report,
  });

  const done = result.features.filter((f) => f.passes).length;

  process.stdout.write(
    `\n[boringstack ${result.status} · ${String(done)}/${String(result.features.length)} resource(s) verified]\n` +
      `📁 code: ${dir}\n`
  );
  process.exit(result.status === "done" ? 0 : 1);
}

async function main(): Promise<void> {
  // `--plan` (plan mode): after the design phase, write the model's build plan to
  // plan.md and proceed (headless never blocks for approval). Strip it before any
  // positional-arg logic so it can sit anywhere on the command line.
  const planMode = process.argv.includes("--plan");

  if (planMode) {
    process.argv = process.argv.filter((a) => a !== "--plan");
  }

  // `--log-file <path>`: write the JSONL event log to a CALLER-CHOSEN path
  // instead of the stamped default under ~/.tsforge/logs — the contract that
  // lets a driver (self-harness evaluate-web) find this run's events
  // deterministically. Stripped before positional-arg logic, like --plan.
  let logFileOverride: string | undefined;
  const logFlagAt = process.argv.indexOf("--log-file");

  if (logFlagAt >= 0) {
    logFileOverride = process.argv[logFlagAt + 1];
    process.argv = process.argv.filter(
      (_, i) => i !== logFlagAt && i !== logFlagAt + 1
    );
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
  // Prefer an explicit entry/env window; otherwise PROBE the server for the real
  // max_model_len (like the REPL does) instead of assuming 262144 — a mismatch
  // mis-calibrates auto-compaction and the build can overflow the real window.
  const contextWindow =
    entry.contextWindow ??
    (Number.isFinite(envWindow) && envWindow > 0
      ? envWindow
      : ((await detectContextWindow(entry)) ?? 262_144));

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

  // BORINGSTACK full-stack path (opt-in): drive the boringstack build loop against
  // a pre-scaffolded clone and exit — skips the UI-only web scaffold entirely.
  if (process.env.TSFORGE_BORINGSTACK === "1") {
    await runBoringstackBranch(
      dir,
      prompt,
      entry,
      contextWindow,
      logFileOverride,
      stamp
    );

    return;
  }

  mkdirSync(dir, { recursive: true });
  await scaffoldWeb(dir, framework);

  if (!existsSync(join(dir, "node_modules"))) {
    const cache = await ensureDepsCache(evalsRoot, framework);

    symlinkSync(cache, join(dir, "node_modules"), "dir");
  }

  const agentLog = join(dir, "agent.log");
  const logFile = logFileOverride ?? join(logsDir(), `${stamp}-headless.jsonl`);

  mkdirSync(logsDir(), { recursive: true });

  const provider = new OpenAICompatibleProvider({
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: resolveApiKey(entry),
    maxTokens: entry.maxTokens ?? PROVIDER_LIMITS.maxTokens,
    // Unattended build: ride out a model-server restart (the local Spark bouncing)
    // for up to 3 min rather than failing the whole run on a transient drop.
    connectRetryMs: 180_000,
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
        ? `${buildWebGate(framework, undefined, dir).command} && bun "${join(import.meta.dir, "coverage-check.ts")}" "${dir}" ${entities
            .map((e) => JSON.stringify(e))
            .join(" ")}`
        : buildWebGate(framework, undefined, dir).command,
    fix: buildWebFix(framework),
    incrementalCheck: buildWebTscCheck(dir),
    // WRITE-TIME LINT: surface the gate's eslint moat rules (no-as, I-prefix,
    // prefer-template) on each file the instant it's written — tsc can't see them,
    // so without this they pile up unseen until the gate (a run log showed 12 `as`
    // casts accumulating that way). cwd = the run dir so vendored ignores resolve.
    // Pass WEB_PACKS so write-time lint enforces the SAME rules the gate does —
    // incl. the react-component-architecture moat (no inline helpers/types/consts
    // in a component, extract computations). Without it those rules were inert at
    // write time and only detonated at the gate as a 20-violation avalanche, the
    // exact end-of-build cascade the write-guard exists to prevent. (cli.ts and
    // interactive-eval.ts already pass WEB_PACKS; the headless/eval path didn't.)
    lintFile: makeFileLinter(framework, dir, WEB_PACKS),
    // Offer the themed-UI-primitives tool so the model generates button/card/input/
    // etc. (tested, theme-coherent) instead of re-authoring them every build.
    scaffoldUi: framework === "react",
    // Self-harness overlay: the `extra` prompt block (append-only, byte-identical
    // when no overlay is active) rides the web guidance — script-level injection
    // so scaffold/ never imports self-harness/ (module-boundaries). The named
    // implement-path blocks deliberately do NOT apply here: they'd contradict
    // the web-specific build guidance.
    guidance:
      activeOverlay()?.promptBlocks.extra === undefined
        ? webGuidance(framework)
        : `${webGuidance(framework)}\n\n${activeOverlay()?.promptBlocks.extra?.text ?? ""}`,
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

  // Model-driven delegation: let the orchestrator spawn read-only specialist
  // subagents (explore/research/verify/review-lens) DURING the build, so this
  // harness exercises the multiagent path end-to-end — not just the main loop.
  const agentSpecs = await loadAgentSpecs(dir, (m) =>
    process.stdout.write(`  ↳ ${m}\n`)
  );
  const delegationConfig = await loadTsforgeConfig(dir);

  session.setDelegation(
    agentSpecs,
    makeSpawnAgentFn({
      specs: agentSpecs,
      cwd: dir,
      concurrency: resolveAgentConcurrency(delegationConfig),
      policyMode: "bypassPermissions",
      contextWindow,
      getTsService: () => session.tsService,
    })
  );

  const result = planMode
    ? await runPlanned(session, prompt, framework, dir)
    : await session.buildStaged(
        prompt,
        {},
        buildWebTypeGate(framework, undefined, dir).command
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
