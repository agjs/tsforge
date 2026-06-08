// Run a from-scratch web build against the LIVE model, NON-interactively — the
// missing piece for an autonomous improve-the-harness loop. It scaffolds (reusing
// node_modules across runs), runs the staged build (plan+types → implement) with
// the real web gate, streams progress, and writes a --log-style JSONL so
// `cli-metrics.ts` can score it (repair turns, tokens, what slipped, salvaged).
//
// Run:  bun run packages/core/scripts/headless-build.ts "build a kanban board" [react|vanilla] [dir]
//   then: bun run packages/core/scripts/cli-metrics.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { rm, cp } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  buildWebFix,
  buildWebGate,
  buildWebTypeGate,
  buildWebTscCheck,
  installWebDeps,
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

function logPath(): string {
  const dir = logsDir();

  mkdirSync(dir, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\..+$/, "");

  return join(dir, `${stamp}-headless.jsonl`);
}

/** Tee progress to the terminal AND a JSONL log (for cli-metrics). */
function makeReporter(logFile: string): Reporter {
  return (event) => {
    process.stdout.write(renderEvent(event, { color: true }));
    appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), ...event })}\n`);
  };
}

async function main(): Promise<void> {
  const prompt = process.argv[2];

  if (prompt === undefined || prompt.length === 0) {
    process.stderr.write(
      'usage: headless-build.ts "<prompt>" [react|vanilla] [dir]\n'
    );
    process.exit(2);
  }

  const framework: WebFramework =
    process.argv[3] === "vanilla" ? "vanilla" : "react";
  // Default into evals/ (gitignored, alongside the other eval targets) so build
  // artifacts + node_modules never touch git; override with the 3rd arg.
  const dir =
    process.argv[4] ??
    join(import.meta.dir, "..", "..", "..", "evals", "headless-build");
  const model = process.env.TSFORGE_MODEL ?? PROVIDER_DEFAULTS.model;
  const envWindow = Number(process.env.TSFORGE_CONTEXT_WINDOW);
  const contextWindow =
    Number.isFinite(envWindow) && envWindow > 0 ? envWindow : 262_144;

  // Clean the model-authored source for a fresh build, but KEEP node_modules so
  // we don't reinstall every loop iteration. scaffoldWeb then rewrites the
  // template src + config.
  await rm(join(dir, "src"), { recursive: true, force: true });
  await scaffoldWeb(dir, framework);

  process.stdout.write(`\n  ↳ ${framework} scaffold ready, installing deps…\n`);
  await installWebDeps(dir);

  const provider = new OpenAICompatibleProvider({
    baseUrl: process.env.TSFORGE_BASE_URL ?? PROVIDER_DEFAULTS.baseUrl,
    model,
    apiKey: process.env.TSFORGE_API_KEY,
    maxTokens: PROVIDER_LIMITS.maxTokens,
  });

  const logFile = logPath();
  const report = makeReporter(logFile);

  process.stdout.write(`  ↳ logging to ${logFile}\n`);
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
    guidance: webGuidance(framework),
    contextWindow,
    // A from-scratch multi-domain app needs more than the 40 default — iter 1 was
    // building cleanly (0 TS2322) but ran out of turns mid-build.
    maxTurns: 80,
    report,
  });

  const result = await session.buildStaged(
    prompt,
    {},
    buildWebTypeGate(framework).command
  );

  // Snapshot the WHOLE project (package.json, vite.config, tsconfig, index.html,
  // components.json, src/ — everything except the heavy/derived node_modules & dist)
  // so each iteration is RUNNABLE: `cd <snapshot> && bun install && bun run dev`.
  // The build dir itself is wiped by the next run. Named after the log + outcome so
  // it lines up with the metrics. Best-effort — never fail the run over a snapshot.
  const stem = basename(logFile, ".jsonl");
  const snapshot = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "evals",
    "loop-snapshots",
    `${stem}-${result.status}`
  );

  try {
    await cp(dir, snapshot, {
      recursive: true,
      filter: (src) => {
        const base = basename(src);

        return base !== "node_modules" && base !== "dist";
      },
    });
  } catch {
    // best-effort — never fail the run over a snapshot
  }

  process.stdout.write(
    `\n[${result.status} · ${result.turns} turn(s)] log: ${logFile}\n` +
      `runnable snapshot: ${snapshot} (cd there, bun install && bun run dev)\n` +
      "score it: bun run packages/core/scripts/cli-metrics.ts\n"
  );
  process.exit(result.status === "done" ? 0 : 1);
}

await main();
