// Drive the BoringStack full-stack build loop non-interactively — the harness's
// web-build path. (The former UI-only Vite/React scaffold path was removed; for web
// apps the harness builds on a real BoringStack clone.) Point this at a
// pre-scaffolded + booted BoringStack clone (from `tsforge scaffold --archetype
// boringstack`):
//
//   bun run packages/core/scripts/headless-build.ts "<build goal>" <clone-dir> [--log-file <path>] [--plan <file>]
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
import { loadApprovedPlan, parsePlan } from "../src/loop/planning/plan-store";

export interface IHeadlessArgs {
  prompt?: string;
  dir?: string;
  logFile?: string;
  planPath?: string;
}

/**
 * Validate and install a plan file from planPath to dir/.specs/next.md.
 * Returns null on success, error message string on failure.
 */
async function installPlanFile(
  planPath: string,
  dir: string
): Promise<string | null> {
  try {
    const planContent = await Bun.file(planPath).text();
    const parsed = parsePlan(planContent);

    if (parsed === null) {
      return `plan file is malformed or missing required fields: ${planPath}`;
    }

    if (parsed.status !== "approved") {
      return `plan must have status "approved", but has status "${parsed.status}": ${planPath}`;
    }

    mkdirSync(join(dir, ".specs"), { recursive: true });
    const destPath = join(dir, ".specs", "next.md");

    await Bun.write(destPath, planContent);

    return null;
  } catch (err: unknown) {
    return `failed to process plan from ${planPath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

/**
 * Parse headless-build command-line arguments into typed fields.
 * Flags (--log-file, --plan) and positionals (prompt, dir) can appear in any order.
 * Returns an object with undefined fields for missing args.
 */
export function parseHeadlessArgs(argv: string[]): IHeadlessArgs {
  const args = [...argv];
  let logFile: string | undefined;
  let planPath: string | undefined;

  // Extract --log-file flag
  const logFlagAt = args.indexOf("--log-file");

  if (logFlagAt >= 0) {
    logFile = args[logFlagAt + 1];
    args.splice(logFlagAt, 2);
  }

  // Extract --plan flag
  const planFlagAt = args.indexOf("--plan");

  if (planFlagAt >= 0) {
    planPath = args[planFlagAt + 1];
    args.splice(planFlagAt, 2);
  }

  // After flag extraction, the remaining positional args are: [prompt, dir, ...]
  const prompt = args[0];
  const dir = args[1];

  return {
    prompt,
    dir,
    logFile,
    planPath,
  };
}

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
  // Parse argv: extract flags (--log-file, --plan) and positionals (prompt, dir)
  // in any order.
  const args = parseHeadlessArgs(process.argv.slice(2));

  const prompt = args.prompt;
  const dir = args.dir;

  if (
    prompt === undefined ||
    prompt.length === 0 ||
    dir === undefined ||
    dir.length === 0
  ) {
    process.stderr.write(
      'usage: headless-build.ts "<build goal>" <boringstack-clone-dir> [--log-file <path>] [--plan <file>]\n'
    );
    process.exit(2);
  }

  // For a greenfield boringstack clone (has apps/api directory), enforce that an
  // approved plan is either already in place or supplied via --plan.
  if (existsSync(join(dir, "apps", "api"))) {
    const approvedPlan = await loadApprovedPlan(dir);

    if (approvedPlan === null && args.planPath === undefined) {
      process.stderr.write(
        `headless-build: greenfield boringstack clone requires an approved plan\n` +
          `  no approved plan found at ${dir}/.specs/next.md\n` +
          `  and no --plan <file> supplied\n` +
          `run planning first or pass --plan <file>\n`
      );
      process.exit(2);
    }

    // If --plan supplied, validate and install it into the clone's .specs/next.md
    if (args.planPath !== undefined) {
      const error = await installPlanFile(args.planPath, dir);

      if (error !== null) {
        process.stderr.write(`headless-build: ${error}\n`);
        process.exit(2);
      }
    }
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

  await driveBuild(dir, prompt, entry, contextWindow, args.logFile, stamp);
}

// Only run main() when actually invoked as a script (not imported for tests)
if (import.meta.main) {
  void main().catch((err: unknown) => {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  });
}
