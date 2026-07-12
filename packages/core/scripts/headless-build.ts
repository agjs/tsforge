// Drive the BoringStack full-stack build loop non-interactively — the harness's
// web-build path. (The former UI-only Vite/React scaffold path was removed; for web
// apps the harness builds on a real BoringStack clone.) Point this at a
// pre-scaffolded + booted BoringStack clone (from `tsforge scaffold --archetype
// boringstack`):
//
//   bun run packages/core/scripts/headless-build.ts "<build goal>" <clone-dir> [--log-file <path>]
//
// The driver plans resources, runs BoringStack's generators + wiring per resource,
// the model fills the domain, and BoringStack's own `validate`/`check` is the gate.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OpenAICompatibleProvider, PROVIDER_LIMITS } from "../src/inference";
import { resolveActiveModel, resolveApiKey } from "../src/models-config";
import { Session, LOOP_LIMITS, type Reporter } from "../src/loop";
import { runBoringstackBuild } from "../src/loop/boringstack/build";
import type { Exec } from "../src/loop/boringstack/exec";
import { detectContextWindow } from "../src/cli/model-setup";
import { renderEvent } from "../src/render";
import { logsDir } from "../src/session-store";

/** Tee progress to the terminal, a human-readable agent.log IN THE CLONE (so you
 *  can `tail -f <clone>/agent.log` next to the code), and a JSONL log for scoring. */
function makeReporter(logFile: string, agentLog: string): Reporter {
  return (event) => {
    process.stdout.write(renderEvent(event, { color: true }));
    appendFileSync(agentLog, renderEvent(event, { color: false }));
    appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), ...event })}\n`);
  };
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

/** `dir` must already be a booted BoringStack clone. The Session is only the build
 *  HOST (setScope + send); the driver runs BoringStack's own generators + gate. */
async function driveBuild(
  dir: string,
  prompt: string,
  entry: Awaited<ReturnType<typeof resolveActiveModel>>["entry"],
  contextWindow: number,
  logFileOverride: string | undefined,
  stamp: string
): Promise<void> {
  if (!existsSync(join(dir, "apps", "api"))) {
    process.stderr.write(
      `expected <dir> to be a scaffolded BoringStack clone (apps/api not found in ` +
        `${dir}). Scaffold it first:\n  tsforge scaffold --archetype boringstack --dest ${dir}\n`
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

  // Normalize the freshly-scaffolded clone before the build. BoringStack's own
  // rename step rewrites identifiers across the repo, which leaves it needing the
  // documented post-rename steps — `regen` (resync the OpenAPI client, ACL, and doc
  // catalogs) and `format` (re-prettier lines whose width the rewrite changed).
  // Without these the PRISTINE scaffold fails its OWN gate (OpenAPI drift + format),
  // so the baseline is red through no fault of the model. Run them here, with deps
  // installed, so the captured baseline is GREEN. Best-effort: a non-zero exit just
  // leaves that defect for the differential gate to exclude, never aborts the build.
  report({
    kind: "tool",
    task: "boringstack",
    message: "regen (post-rename sync)",
  });
  await boringstackExec(["bun", "run", "regen"], { cwd: dir });

  for (const app of ["apps/api", "apps/ui"]) {
    report({ kind: "tool", task: "boringstack", message: `format (${app})` });
    await boringstackExec(["bun", "run", "format"], { cwd: join(dir, app) });
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
    // BoringStack ships a convention library — offer pull_conventions so the model
    // can fetch its how-to patterns on demand (decoupled from any flag).
    pullConventions: true,
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
  // `--log-file <path>`: write the JSONL event log to a CALLER-CHOSEN path (so a
  // driver can find this run's events deterministically). Stripped before the
  // positional-arg logic.
  let logFileOverride: string | undefined;
  const logFlagAt = process.argv.indexOf("--log-file");

  if (logFlagAt >= 0) {
    logFileOverride = process.argv[logFlagAt + 1];
    process.argv = process.argv.filter(
      (_, i) => i !== logFlagAt && i !== logFlagAt + 1
    );
  }

  const prompt = process.argv[2];
  const dir = process.argv[3];

  if (
    prompt === undefined ||
    prompt.length === 0 ||
    dir === undefined ||
    dir.length === 0
  ) {
    process.stderr.write(
      'usage: headless-build.ts "<build goal>" <boringstack-clone-dir> [--log-file <path>]\n'
    );
    process.exit(2);
  }

  // The model comes from the registry (~/.tsforge/models.json) unless TSFORGE_*
  // env overrides it.
  const { entry } = await resolveActiveModel();
  const envWindow = Number(process.env.TSFORGE_CONTEXT_WINDOW);
  const contextWindow =
    entry.contextWindow ??
    (Number.isFinite(envWindow) && envWindow > 0
      ? envWindow
      : ((await detectContextWindow(entry)) ?? 262_144));

  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\..+$/, "");

  await driveBuild(dir, prompt, entry, contextWindow, logFileOverride, stamp);
}

void main();
