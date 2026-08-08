/**
 * `/work` REPL flow: resume or parse a checklist, optionally plan from a goal,
 * then drive `runWorklist` with a fresh task per item.
 */
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { createInterface } from "node:readline/promises";
import type { OpenAICompatibleProvider } from "../inference";
import type { IModelEntry } from "../models-config";
import { resolveCapabilityModel, resolveModelByName } from "../models-config";
import {
  hasState,
  loadState,
  planFeatures,
  renderProgress,
  type IGreenfieldState,
} from "../loop/greenfield";
import {
  acceptMapOf,
  parseWorklist,
  prepareWorklistState,
  resolveWorklistPath,
  runWorklist,
  tickWorklistFile,
  WORKLIST_STATE,
} from "../loop/worklist";
import type { IWorklistItem } from "../loop/worklist";
import type { Reporter } from "../loop";
import { makeProvider, envNumber } from "./model-setup";
import { makeReporter } from "./logging";
import { scopeOf, type ICliArgs } from "./args";
import { createWorklistDeps } from "./worklist-deps";

type Rl = ReturnType<typeof createInterface> | null;

export interface IRunWorkCommandOpts {
  args: ICliArgs;
  arg: string;
  echo: (s: string) => void;
  /**
   * Classic readline (null when the multiline editor owns stdin). Prefer
   * {@link askApprove} under the pane console — `rl.question` is unavailable there.
   */
  rl: Rl;
  /**
   * Interactive approve/cancel when `rl` is null (pane editor). Overlay menus,
   * etc. When both `rl` and this are absent, planning cancels as non-interactive.
   */
  askApprove?: () => Promise<"approve" | "cancel">;
  workProvider: OpenAICompatibleProvider;
  activeModelEntry: IModelEntry;
  /** Session gate command (may be empty). */
  gate: string;
  /** Opt-in tick of the human file. */
  tick?: boolean;
  logFile: string;
  id: string;
  /** Push worklist slot lines into the live region (Phase 2). */
  onProgress?: (state: IGreenfieldState) => void;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

async function resolveArgPath(
  cwd: string,
  arg: string
): Promise<string | null> {
  if (arg.length === 0) {
    return resolveWorklistPath(cwd);
  }

  const candidate = isAbsolute(arg) ? arg : join(cwd, arg);

  if (await pathExists(candidate)) {
    return candidate;
  }

  return null;
}

/** Prompt for plan approval. Exported for unit tests. */
export async function approvePlan(
  echo: (s: string) => void,
  checklist: string,
  ask: (() => Promise<"approve" | "cancel">) | null
): Promise<"approve" | "cancel"> {
  echo(`\nProposed worklist:\n${checklist}\n`);
  echo("Approve this list? (approve/cancel)\n");

  if (ask === null) {
    echo("(non-interactive — cancelling)\n");

    return "cancel";
  }

  return ask();
}

function approveAskFromOpts(
  opts: IRunWorkCommandOpts
): (() => Promise<"approve" | "cancel">) | null {
  if (opts.askApprove !== undefined) {
    return opts.askApprove;
  }

  const { rl } = opts;

  if (rl === null) {
    return null;
  }

  return async () => {
    const answer = (await rl.question("> ")).trim().toLowerCase();

    return answer === "approve" || answer === "approved" || answer === "go"
      ? "approve"
      : "cancel";
  };
}

/**
 * Plan a worklist from a free-text goal and ask for approval.
 * Persistence is left to the caller.
 */
async function planFromGoal(
  opts: IRunWorkCommandOpts,
  goal: string
): Promise<IWorklistItem[] | null> {
  const { echo, activeModelEntry } = opts;

  echo("▸ planning a worklist from your goal...\n");

  const plannerResolved = await resolveCapabilityModel("planner");
  const planner = makeProvider(plannerResolved?.entry ?? activeModelEntry);
  const planned = await planFeatures(planner, goal);

  if (planned === null || planned.features.length === 0) {
    echo("planner produced no items — nothing to run\n");

    return null;
  }

  const preview = renderProgress({
    goal,
    features: planned.features,
  });

  if (
    (await approvePlan(echo, preview, approveAskFromOpts(opts))) !== "approve"
  ) {
    echo("worklist cancelled\n");

    return null;
  }

  return planned.features.map((f) => ({
    id: f.id,
    text: f.desc,
    done: false,
  }));
}

/** Load accepts from a source markdown file (best-effort on resume). */
async function acceptsFromFile(
  path: string | null
): Promise<Map<string, string>> {
  if (path === null) {
    return new Map();
  }

  try {
    const items = parseWorklist(await readFile(path, "utf8"), {
      includeDone: true,
    });

    return acceptMapOf(items);
  } catch {
    return new Map();
  }
}

interface IResolvedWorklist {
  state: IGreenfieldState;
  sourcePath: string | null;
  accepts: Map<string, string>;
}

/** Persist planned items under `.tsforge/worklist/` and return the resolved start. */
async function persistPlannedItems(
  opts: IRunWorkCommandOpts,
  items: IWorklistItem[],
  sourcePath: string | null,
  goal: string
): Promise<IResolvedWorklist | null> {
  const state = await prepareWorklistState(opts.args.dir, { goal, items });

  return state === null
    ? null
    : { state, sourcePath, accepts: acceptMapOf(items) };
}

/** File had no checklist markers — ask the planner to extract items from prose. */
async function planFromNarrativeFile(
  opts: IRunWorkCommandOpts,
  asPath: string
): Promise<IResolvedWorklist | null> {
  const md = (await readFile(asPath, "utf8")).trim();
  const items = await planFromGoal(
    opts,
    md.length > 0 ? md.slice(0, 12_000) : opts.arg
  );

  return items === null
    ? null
    : persistPlannedItems(opts, items, asPath, opts.arg);
}

async function resolveWorklistStart(
  opts: IRunWorkCommandOpts,
  asPath: string | null,
  isGoal: boolean
): Promise<IResolvedWorklist | null> {
  const cwd = opts.args.dir;

  if (await hasState(cwd, WORKLIST_STATE)) {
    const state = await prepareWorklistState(cwd, { goal: "worklist" });

    return state === null
      ? null
      : { state, sourcePath: asPath, accepts: new Map() };
  }

  if (!isGoal) {
    const state = await prepareWorklistState(cwd, {
      goal: "worklist",
      ...(asPath !== null ? { path: asPath } : {}),
    });

    if (state !== null) {
      return {
        state,
        sourcePath: asPath ?? (await resolveWorklistPath(cwd)),
        accepts: new Map(),
      };
    }

    return asPath === null ? null : planFromNarrativeFile(opts, asPath);
  }

  const items = await planFromGoal(opts, opts.arg);

  return items === null
    ? null
    : persistPlannedItems(opts, items, null, opts.arg);
}

function stuckMessage(result: Awaited<ReturnType<typeof runWorklist>>): string {
  if (result.status === "done") {
    return "✓ all worklist items verified";
  }

  if (result.status === "needs-infra") {
    return `✗ infrastructure unavailable: ${result.infra ?? "?"}`;
  }

  const parkedIds = result.features
    .filter((f) => f.parked === true)
    .map((f) => f.id);
  const parked =
    parkedIds.length > 0 ? parkedIds.join(", ") : (result.stuckFeature ?? "?");

  return `✗ stuck — parked: ${parked}`;
}

/** Execute `/work [file|goal]`. */
export async function runWorkCommand(opts: IRunWorkCommandOpts): Promise<void> {
  const { args, arg, echo, workProvider, gate, logFile, id } = opts;
  const cwd = args.dir;
  const asPath = await resolveArgPath(cwd, arg);
  const isGoal = arg.length > 0 && asPath === null;
  const resolved = await resolveWorklistStart(opts, asPath, isGoal);

  if (resolved === null) {
    echo(
      "no worklist found — add PLAN.md / TASKS.md, pass a file, or `/work <goal>`\n"
    );

    return;
  }

  const { state, sourcePath } = resolved;
  let { accepts } = resolved;

  if (accepts.size === 0) {
    accepts = await acceptsFromFile(sourcePath);
  }

  if ((gate.length === 0 || gate === "true") && accepts.size === 0) {
    echo(
      "worklist needs a gate — `/gate '<cmd>'` or per-item `accept:` in the list\n"
    );

    return;
  }

  echo(
    `▸ worklist: ${state.features.filter((f) => f.passes).length}/${state.features.length} done — driving remaining items\n`
  );

  const evaluatorName =
    opts.args.evaluatorModel.length > 0
      ? opts.args.evaluatorModel
      : opts.args.model;
  const evaluator = makeProvider(
    evaluatorName.length > 0
      ? (await resolveModelByName(evaluatorName)).entry
      : opts.activeModelEntry
  );
  const baseReport = makeReporter(logFile, id, `${id}-work`);
  const thinkingTokenBudget = envNumber("TSFORGE_THINKING_BUDGET");

  opts.onProgress?.(state);

  const report: Reporter = (event) => {
    baseReport(event);

    if (opts.onProgress === undefined) {
      return;
    }

    void loadState(cwd, WORKLIST_STATE).then((latest) => {
      if (latest !== null) {
        opts.onProgress?.(latest);
      }
    });
  };

  const deps = createWorklistDeps({
    cwd,
    accept: gate,
    accepts,
    scope: scopeOf(args),
    work: workProvider,
    evaluator,
    report,
    ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
    ...(args.maxTurns > 0 ? { maxTurns: args.maxTurns } : {}),
  });

  const result = await runWorklist(cwd, state, deps, { onEvent: report });

  opts.onProgress?.({ ...state, features: result.features });

  if (opts.tick === true && sourcePath !== null) {
    await tickWorklistFile(sourcePath, result.features);
  }

  const done = result.features.filter((f) => f.passes).length;

  echo(
    `\n${stuckMessage(result)} (${done}/${result.features.length}) — see .tsforge/${WORKLIST_STATE}/progress.md\n`
  );
}
