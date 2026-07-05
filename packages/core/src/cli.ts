#!/usr/bin/env bun
import { join, isAbsolute } from "node:path";
import { renderCheck } from "./browser";
import {
  runTask,
  RUN_STATUS,
  reviewChange,
  reviewRepair,
  formatReport,
  runGreenfield,
  prepareState,
  evaluateFeature,
  planFeatures,
  judgeFeature,
  type IFeature,
  type IGreenfieldDeps,
  type Reporter,
} from "./loop";
import { modelAgent } from "./agent";
import { loadRecipes, findRecipe } from "./config/recipes";
import {
  parseArgs,
  applyRecipe,
  isOneShot,
  scopeOf,
  cliUsage,
  type ICliArgs,
} from "./cli/args";
import { validate } from "./validate";
import type { OpenAICompatibleProvider } from "./inference";
import { resolveActiveModel, resolveModelByName } from "./models-config";
import type { ITask } from "./spec";
import { readFiles, runShellCommand } from "./lib/fs";
import { currentVersion } from "./update-check";
import { trace } from "./lib/trace";
import { repl } from "./cli/repl";
import { runMapCommand, runTraceCommand } from "./cli/repl-commands";
import { makeProvider, modelForRun, envNumber } from "./cli/model-setup";
import { makeReporter, resolveLogPath } from "./cli/logging";
import { resolveGate } from "./cli/gate-setup";

/**
 * The tsforge CLI — the product surface over the same engine the eval harness
 * uses (see cli-product-direction). Like any agentic CLI: cd into a repo, run it,
 * and talk. The agent reads/runs/edits the whole workspace by default.
 *
 *   tsforge                       # interactive session in the current repo
 *   tsforge --dir ~/app           # ...in another repo
 *   tsforge "fix the build"       # interactive, with that as the first message
 *   tsforge "fix X" --accept "npm test"   # one-shot: drive to green, then exit
 *   tsforge --continue            # resume the most recent session for this dir
 *
 * The eval-only knobs are now OPTIONAL refinements, never required:
 *   --files "<globs>"   narrow the editable scope (default: the whole workspace)
 *   --accept "<cmd>"    a gate that confirms "done" (default: stop when the model
 *                       stops — like any chat agent). With a gate set, tsforge's
 *                       deterministic check enforces correctness; it can't be faked.
 *   --log               record the full event stream (reasoning, every file the
 *                       agent writes, gate verdicts, timing) as JSONL to an
 *                       auto-named ~/.tsforge/logs/<timestamp>-<id>.jsonl — the
 *                       record to evaluate runs and see where the model got stuck.
 * Slash commands (/help, /clear, /exit) follow the standard harness UX. Provider
 * via TSFORGE_* env.
 */
export { parseArgs, applyRecipe, isOneShot, type ICliArgs } from "./cli/args";

export { makeSpinner, spinnerPhase, type ISpinnerOut } from "./render/spinner";
export { providerConfig } from "./cli/model-setup";
export { isApproval, isPlanApproval } from "./cli/repl";

/** One-shot: drive a single task to green, then exit. */
async function runOnce(args: ICliArgs): Promise<number> {
  const task: ITask = {
    id: "cli",
    intent: args.task,
    accept: args.accept,
    files: scopeOf(args),
    context: [],
  };

  const logFile = resolveLogPath("cli", args.log);

  if (logFile.length > 0) {
    process.stdout.write(`  ↳ logging this run to ${logFile}\n`);
  }

  const thinkingTokenBudget =
    args.thinkingBudget > 0
      ? args.thinkingBudget
      : envNumber("TSFORGE_THINKING_BUDGET");
  const { entry } = await modelForRun(args);
  const provider = makeProvider(entry);
  const report = makeReporter(logFile, "cli");
  const result = await runTask(task, args.dir, provider, {
    onEvent: report,
    ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
    ...(args.maxTurns > 0 ? { maxTurns: args.maxTurns } : {}),
    ...(args.scout ? { scout: true } : {}),
  });
  const ok = result.status === RUN_STATUS.done;

  process.stdout.write(
    `\n${ok ? "✓ done" : `✗ ${result.status}`} in ${String(result.cycles)} turn(s)\n`
  );

  // Optional post-green adversarial review + one repair cycle (reverts if it
  // breaks the gate). Only meaningful once the task is actually green.
  if (ok && args.withReview) {
    await reviewRepair(provider, args.dir, task, modelAgent(provider), {
      ...(args.base.length > 0 ? { base: args.base } : {}),
      onEvent: report,
    });
  }

  return ok ? 0 : 1;
}

/** Run the auto/explicit gate ONCE and return its distinct failing rule ids, so a
 *  gate-aware review skips what the gate already covers. Green/no-gate → []. */
async function gateFailingRules(args: ICliArgs): Promise<string[]> {
  // Running the gate can throw (missing deps, a broken gate command, env issues).
  // A gate-aware review is an enhancement, never a hard dependency — on any failure
  // fall back to a full review instead of crashing the command.
  try {
    const gate = await resolveGate(args, null);

    if (gate.accept.length === 0) {
      return [];
    }

    const task: ITask = { id: "review", accept: gate.accept, files: [] };
    const result = await validate(task, args.dir);

    if (result.passed) {
      return [];
    }

    const rules = new Set<string>();

    for (const error of result.errors) {
      if (typeof error.rule === "string" && error.rule.length > 0) {
        rules.add(error.rule);
      }
    }

    return [...rules];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    process.stdout.write(
      `gate: couldn't run the gate (${message}) — falling back to full review\n`
    );

    return [];
  }
}

async function reviewMode(args: ICliArgs): Promise<number> {
  const { entry } = await resolveActiveModel();
  const rules = args.withGate ? await gateFailingRules(args) : [];

  if (args.withGate) {
    process.stdout.write(
      rules.length > 0
        ? `gate: ${rules.length} failing rule(s) — review will skip what they cover\n`
        : "gate: green — full functional review\n"
    );
  }

  const report = await reviewChange(makeProvider(entry), args.dir, {
    ...(args.base.length > 0 ? { base: args.base } : {}),
    staged: args.staged,
    ...(rules.length > 0 ? { gateFailingRules: rules } : {}),
    log: (m) => process.stdout.write(`  ↳ ${m}\n`),
  });

  process.stdout.write(`\n${formatReport(report)}\n`);

  // Exit non-zero when there are error-severity findings, so it's CI-usable.
  return report.findings.some((f) => f.severity === "error") ? 1 : 0;
}

async function mapMode(args: ICliArgs): Promise<number> {
  await runMapCommand(args.dir, args.task);

  return 0;
}

/** `tsforge setup` — the onboarding wizard that infers + writes project
 *  conventions. `--yes` writes the recommendations non-interactively. */
async function setupMode(args: ICliArgs): Promise<number> {
  const { runSetup } = await import("./setup/run-setup");

  return runSetup({
    cwd: args.dir,
    yes: args.setupYes,
    color: process.stdout.isTTY,
  });
}

/** `tsforge recipes` — list the recipes discovered for this repo. */
async function recipesMode(args: ICliArgs): Promise<number> {
  const recipes = await loadRecipes(args.dir, (m) =>
    process.stdout.write(`  ${m}\n`)
  );

  if (recipes.length === 0) {
    process.stdout.write(
      "no recipes found — add .tsforge/recipes/<id>.json (see the docs)\n"
    );

    return 0;
  }

  process.stdout.write("Recipes:\n");

  for (const recipe of recipes) {
    const desc =
      recipe.description === undefined ? "" : ` — ${recipe.description}`;

    process.stdout.write(`  ${recipe.id}${desc}\n`);
  }

  return 0;
}

/** Resolve `--recipe`/`tsforge run <id>` and overlay it onto args. Returns an
 *  exit code to abort on (unknown id), or null to continue dispatching. */
async function applyRecipeArg(args: ICliArgs): Promise<number | null> {
  if (args.recipe.length === 0) {
    return null;
  }

  const recipes = await loadRecipes(args.dir, (m) =>
    process.stdout.write(`  ${m}\n`)
  );
  const recipe = findRecipe(recipes, args.recipe);

  if (recipe === undefined) {
    process.stdout.write(
      `unknown recipe: ${args.recipe} — run \`tsforge recipes\` to list them\n`
    );

    return 1;
  }

  applyRecipe(args, recipe);
  process.stdout.write(`using recipe '${recipe.id}'\n`);

  return null;
}

async function traceMode(args: ICliArgs): Promise<number> {
  return runTraceCommand(args.task);
}

/** Concatenate the editable scope into a single, size-capped code window for the
 *  feature judge — the BUILT ARTIFACT only (design-rule #2: no tool trace). */
async function scopeCode(dir: string, files: string[]): Promise<string> {
  const views = await readFiles(dir, files);
  const joined = views.map((v) => `// ${v.path}\n${v.content}`).join("\n\n");
  const CAP = 16000;

  return joined.length > CAP ? `${joined.slice(0, CAP)}\n…[truncated]` : joined;
}

/** Build the greenfield deps: implement one feature with the work model (reusing
 *  the headless runTask driver against the build gate), then evaluate it through
 *  the layered stack — deterministic gate, optional browser steps, reject-by-
 *  default judge on the EVALUATOR model (which only ever sees the built code). */
function greenfieldDeps(
  args: ICliArgs,
  work: OpenAICompatibleProvider,
  evaluator: OpenAICompatibleProvider,
  scope: string[],
  report: Reporter
): IGreenfieldDeps {
  const featureTask = (feature: IFeature): ITask => ({
    id: feature.id,
    intent: `${args.task}\n\nImplement this feature: ${feature.desc}`,
    accept: args.accept,
    files: scope,
    context: [],
  });

  const thinkingTokenBudget =
    args.thinkingBudget > 0
      ? args.thinkingBudget
      : envNumber("TSFORGE_THINKING_BUDGET");

  return {
    implement: async (feature) => {
      const base = featureTask(feature);

      await runTask({ ...base, intent: base.intent }, args.dir, work, {
        onEvent: report,
        // The global gate is often already green between features, so don't
        // bail RED-first — the model must still build this feature.
        requireRed: false,
        ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
        ...(args.maxTurns > 0 ? { maxTurns: args.maxTurns } : {}),
      });
    },
    evaluate: (feature) =>
      evaluateFeature(feature, {
        gate: async () => {
          const v = await validate(featureTask(feature), args.dir);

          return { passed: v.passed, output: v.output };
        },
        // The browser layer runs the feature's steps only when a render target
        // (`--browser <html>`) is configured; otherwise it's a no-op skip (the
        // build gate already browser-smokes web apps).
        browser: async () =>
          args.browser.length > 0
            ? renderCheck({
                // Resolve a relative --browser against the RUN dir (--dir), not the
                // launcher's cwd — greenfield checks run in-process, unlike the
                // normal gate which already runs inside --dir.
                file: isAbsolute(args.browser)
                  ? args.browser
                  : join(args.dir, args.browser),
                smoke: true,
                ...(feature.steps === undefined
                  ? {}
                  : { steps: feature.steps }),
              })
            : { ok: true, errors: [], skipped: true },
        judge: async () =>
          judgeFeature(evaluator, {
            feature: feature.desc,
            code: await scopeCode(args.dir, scope),
          }),
      }),
  };
}

/** A `--notify` hook is bounded: an unattended/cron run must not hang forever on a
 *  notifier that wedges (a `curl` to a dead host with no `--max-time`, a stray
 *  `read` on stdin). 30s is generous for a real ping yet always lets the run end. */
const NOTIFY_TIMEOUT_MS = 30_000;

/** Run the `--notify` shell command (if any) with the run outcome in
 *  $TSFORGE_STATUS — a ping for unattended/cron runs. Best-effort: a failing,
 *  missing, OR HANGING notifier never changes the run's exit code, because it
 *  routes through the shared runner (uniform kill-timeout) and is bounded. */
export async function runNotify(
  cwd: string,
  cmd: string,
  status: string,
  timeoutMs: number = NOTIFY_TIMEOUT_MS
): Promise<void> {
  if (cmd.length === 0) {
    return;
  }

  try {
    await runShellCommand(cwd, cmd, {
      timeoutMs,
      env: { ...process.env, TSFORGE_STATUS: status },
      onChunk: (text) => process.stdout.write(text),
    });
  } catch (err) {
    // A broken notifier must not break the run.
    trace("cli.notify", err);
  }
}

/** `tsforge --greenfield "<goal>"` / a recipe with `mode: "greenfield"`: plan a
 *  feature checklist (planner model), then drive it to all-green one feature at a
 *  time on the existing gate + browser + judge stack, persisting state so a long
 *  run resumes. Roles route to separate models when configured, else all share
 *  the active model. */
async function greenfieldMode(args: ICliArgs): Promise<number> {
  if (args.task.length === 0) {
    process.stdout.write(
      'missing build goal — usage: tsforge --greenfield "build a kanban app"\n'
    );

    return 1;
  }

  if (args.accept.length === 0) {
    process.stdout.write(
      "greenfield needs a build gate — pass --accept '<cmd>' or set `gate` in the recipe\n"
    );

    return 1;
  }

  // Each role falls back to the recipe's `model` (then the active model), per the
  // recipe contract — a recipe that sets only `model` must route ALL roles there,
  // not just the work role.
  const roleName = (specific: string): string =>
    specific.length > 0 ? specific : args.model;
  const planner = makeProvider(
    (await resolveModelByName(roleName(args.plannerModel))).entry
  );
  const work = makeProvider(
    (await resolveModelByName(roleName(args.workModel))).entry
  );
  const evaluator = makeProvider(
    (await resolveModelByName(roleName(args.evaluatorModel))).entry
  );

  const state = await prepareState(args.dir, args.task, (goal) =>
    planFeatures(planner, goal)
  );

  if (state === null) {
    process.stdout.write("planner produced no features — nothing to build\n");

    return 1;
  }

  const report = makeReporter(
    resolveLogPath("greenfield", args.log),
    "greenfield"
  );
  const scope = scopeOf(args);
  const result = await runGreenfield(
    args.dir,
    state,
    greenfieldDeps(args, work, evaluator, scope, report),
    { onEvent: report }
  );

  const done = result.features.filter((f) => f.passes).length;

  process.stdout.write(
    `\n${result.status === "done" ? "✓ all features verified" : `✗ stuck on '${result.stuckFeature ?? "?"}'`} (${done}/${result.features.length})\n`
  );

  await runNotify(
    args.dir,
    args.notify,
    `greenfield ${result.status} ${done}/${result.features.length}`
  );

  return result.status === "done" ? 0 : 1;
}

/**
 * `tsforge scaffold …` — greenfield wizard that stands up boringstack (or its
 * Astro static site). Delegates the remaining argv to the scaffold command's own
 * parser (--archetype/--stack/--dest/--set/--multi/--ref/--no-boot), so its
 * vocabulary doesn't collide with the harness flags. Prints the handoff (where +
 * how to run the gate); the model-driven build loop is then a normal `tsforge`
 * invocation against that dir + gate.
 */
async function scaffoldMode(argv: readonly string[]): Promise<number> {
  const { runScaffoldCommand } = await import("./scaffold/scaffold-command");
  const outcome = await runScaffoldCommand(argv, process.stdout.isTTY);

  if (outcome === null) {
    process.stdout.write("scaffold: cancelled — nothing was created.\n");

    return 1;
  }

  process.stdout.write(
    [
      "",
      `scaffold ready → ${outcome.dir}`,
      `  cloned   ${outcome.resolvedSha}`,
      `  booted   ${String(outcome.booted)}${outcome.bootError === undefined ? "" : ` (${outcome.bootError})`}`,
      "",
      "configured .env:",
      ...outcome.summary.map((l) => `  ${l}`),
      "",
      "build it:",
      `  tsforge --dir ${outcome.gateCwd} --accept '${outcome.gateCommand}' "<your first feature>"`,
      "",
    ].join("\n")
  );

  return outcome.bootError === undefined ? 0 : 1;
}

export async function main(): Promise<number> {
  const raw = process.argv.slice(2);

  if (raw[0] === "scaffold") {
    return scaffoldMode(raw.slice(1));
  }

  const args = parseArgs(raw);

  // `--version`/`--help` print and exit — before this fix an unknown flag fell
  // through as a POSITIONAL, so `tsforge --version` booted a session with the
  // literal task "--version" (and install.sh advertises `tsforge --help`).
  if (args.version) {
    process.stdout.write(`tsforge ${currentVersion()}\n`);

    return 0;
  }

  if (args.help) {
    process.stdout.write(cliUsage());

    return 0;
  }

  if (args.recipes) {
    return recipesMode(args);
  }

  if (args.run && args.recipe.length === 0) {
    process.stdout.write(
      "missing recipe id — usage: tsforge run <id> [task] (see `tsforge recipes`)\n"
    );

    return 1;
  }

  // A `--recipe`/`run <id>` overlays the recipe's fields onto args (CLI wins),
  // then dispatch continues as if those were passed directly.
  const recipeAbort = await applyRecipeArg(args);

  if (recipeAbort !== null) {
    return recipeAbort;
  }

  if (args.review) {
    return reviewMode(args);
  }

  if (args.map) {
    return mapMode(args);
  }

  if (args.trace) {
    return traceMode(args);
  }

  if (args.setup) {
    return setupMode(args);
  }

  if (args.greenfield) {
    return greenfieldMode(args);
  }

  // A positional task with a scope + gate ⇒ one-shot; otherwise interactive.
  return isOneShot(args) ? runOnce(args) : repl(args);
}

// Direct run (`bun src/cli.ts`, dev). The published binary instead imports
// `main` from bin/tsforge.js, because `import.meta.main` is false when this
// module is imported rather than executed as the entry point.
if (import.meta.main) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `tsforge: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    });
}
