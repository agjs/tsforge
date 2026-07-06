import type { ITask } from "../spec";
import type { IChatMessage, IModelResponse, IProvider } from "../inference";
import { validate, type ErrorParser, type IValidateResult } from "../validate";
import { readFiles, type IFileView } from "../lib/fs";
import { trace } from "../lib/trace";
import {
  DEFAULT_TEMPERATURE,
  RUN_STATUS,
  STUCK_REASON,
  LOOP_LIMITS,
} from "./loop.constants";
import type {
  IRunResult,
  IRunOptions,
  Reporter,
  ILoopEvent,
} from "./loop.types";
import { mineLessons, consolidate as consolidateMemory } from "./memory";
import type { ITsforgeProjectConfig } from "../config";
import type { ProfileId } from "../config/profiles";
import type { IConventions } from "../infer-rules/conventions.types";
import type { PolicyMode, IPolicyRules } from "../policy";
import { buildSystemPrompt, seedPrompt } from "./prompt";
import { buildScoutContext } from "./scout";
import { detectStack } from "../stack-detection";
import type { TtsrManager } from "./ttsr";
import {
  initTtsrManager,
  loadProjectTtsrRules,
  applyTtsrInterrupt,
} from "./ttsr-init";
import {
  type ILoopCtx,
  type ILoopState,
  toolsFor,
  buildTsService,
  runToolCalls,
  settleGate,
  emitTiming,
  NO_TOOL_CALL_NUDGE,
} from "./turn";

/** Report any salvaged malformed tool calls, then stop the task if the stream
 *  degenerated into a repetition loop (returns a terminal stuck result; null to
 *  keep going) — mirrors the interactive Session's degeneration handling. */
function handleDegeneration(
  res: IModelResponse,
  ctx: ILoopCtx,
  state: ILoopState,
  at: { turn: number; turnStart: number; taskStart: number }
): IRunResult | null {
  const { report } = ctx;
  const { id } = ctx.task;

  if (res.salvaged !== undefined && res.salvaged > 0) {
    report({
      kind: "tool",
      task: id,
      message: `recovered ${res.salvaged} malformed tool call(s) (server tool-call parser mismatch)`,
    });
  }

  if (res.degenerated !== true) {
    return null;
  }

  report({
    kind: "stuck",
    task: id,
    cycles: at.turn,
    message:
      "model fell into a repetition loop - stopped. Try a smaller task or steer it with a narrower instruction.",
  });
  emitTiming(report, id, at.turn, at.turnStart, at.taskStart);

  return {
    task: id,
    redConfirmed: true,
    status: RUN_STATUS.stuck,
    cycles: at.turn,
    reason: STUCK_REASON.stalled,
    edits: state.edits,
    regressions: state.regressions,
  };
}

// TTSR init + project/learned-rule loading live in the shared ttsr-init module
// (the interactive session uses the same loaders). Re-exported here so existing
// importers (and tests) keep their path.
export { initTtsrManager, loadProjectTtsrRules };

/** Handle a TTSR interrupt in the headless loop: apply the shared interrupt
 *  (count, report, inject corrective guidance, disable at the cap) then emit
 *  timing for the interrupted turn. */
function handleTtsrInterrupt(
  ttsrFired: { ruleName: string; guidance: string },
  state: ILoopState,
  messages: IChatMessage[],
  report: Reporter,
  taskId: string,
  turn: number,
  turnStart: number,
  taskStart: number,
  ttsrManager: TtsrManager | null
): void {
  applyTtsrInterrupt(ttsrFired, state, messages, report, taskId, ttsrManager);
  emitTiming(report, taskId, turn, turnStart, taskStart);
}

/**
 * MEMORY post-run hook: mine this run's events for failure→fix lessons and
 * consolidate them into `.tsforge/`. Best-effort: a memory failure never
 * affects the run's result. `runId` is unique per run so the same task re-run
 * counts as a distinct session for the recurrence gate.
 */
async function consolidateLessons(
  cwd: string,
  events: readonly ILoopEvent[],
  runId: string,
  report: Reporter
): Promise<void> {
  try {
    const candidates = mineLessons(events);
    const active = await consolidateMemory(cwd, candidates, runId);

    if (active > 0) {
      report({
        kind: "ttsr",
        task: runId,
        message: `memory: ${String(active)} learned rule(s) active in .tsforge/learned-rules.json`,
      });
    }
  } catch (err) {
    // Memory is supplementary — never let it break a run.
    trace("run.memory", err);
  }
}

/** Assemble per-call completion options, leaving optional knobs unset when absent. */
function completionOptionsFor(args: {
  tools: unknown[];
  temperature: number;
  enableThinking: boolean | undefined;
  thinkingTokenBudget: number | undefined;
  ttsrManager: TtsrManager | null;
  report: Reporter;
  taskId: string;
}): Parameters<IProvider["complete"]>[1] {
  return {
    tools: args.tools,
    temperature: args.temperature,
    toolChoice: "auto",
    ...(args.enableThinking === undefined
      ? {}
      : { enableThinking: args.enableThinking }),
    ...(args.thinkingTokenBudget === undefined
      ? {}
      : { thinkingTokenBudget: args.thinkingTokenBudget }),
    ...(args.ttsrManager === null ? {} : { ttsrManager: args.ttsrManager }),
    onToken: (text) => {
      args.report({ kind: "token", task: args.taskId, message: text });
    },
  };
}

function effectiveParserFor(
  parse: ErrorParser | undefined
): ErrorParser | undefined {
  return parse;
}

/** Detect the stack and fold in tsforge.config.json pack/rule overrides, plus any
 *  rule packs from configured external plugins. */
/** The optional policy fields for the loop context (kept off `runTask` so its
 *  `exactOptionalPropertyTypes` spreads don't inflate its cognitive complexity). */
function policyCtxFields(policy: ITsforgeProjectConfig["policy"]): {
  policyMode?: PolicyMode;
  policyRules?: IPolicyRules;
} {
  return {
    ...(policy?.mode === undefined ? {} : { policyMode: policy.mode }),
    ...(policy?.rules === undefined ? {} : { policyRules: policy.rules }),
  };
}

async function resolveStackForRun(
  cwd: string,
  report: (message: string) => void,
  profile?: ProfileId
): Promise<{
  stackProfile: Awaited<ReturnType<typeof detectStack>>;
  ruleOverrides: Readonly<Record<string, "error" | "warn" | "off">>;
  policy: ITsforgeProjectConfig["policy"];
  conventions: IConventions;
}> {
  const detectedProfile = await detectStack(cwd);
  const {
    loadTsforgeConfig,
    resolveActivePacks,
    normalizeRuleOverrides,
    withProfileOverride,
  } = await import("../config/tsforge-config");
  const { resolveConventions } = await import("../infer-rules/conventions");
  const { loadAndRegisterPlugins } = await import("../config/external-plugins");
  const cfg = withProfileOverride(await loadTsforgeConfig(cwd), profile);
  const activePacks = resolveActivePacks(detectedProfile.packs, cfg);
  const externalIds =
    cfg.plugins === undefined
      ? []
      : await loadAndRegisterPlugins(cfg.plugins, cwd, report);

  return {
    stackProfile: {
      ...detectedProfile,
      packs:
        externalIds.length > 0 ? [...activePacks, ...externalIds] : activePacks,
    },
    ruleOverrides: normalizeRuleOverrides(cfg),
    policy: cfg.policy,
    conventions: resolveConventions(cfg.conventions),
  };
}

/**
 * The implement loop as a persistent, tool-using conversation. The model drives
 * — it can `read`, `run` (tests/tsc/eslint), `edit`, `create` — and the whole
 * conversation is retained as memory. When it stops calling tools (believes it's
 * done), the harness runs the deterministic gate, which is the ONLY authority on
 * "done": green ⇒ finished; red ⇒ the errors go back into the conversation and it
 * continues. It can't fake completion.
 *
 * This is the RED-first, drive-to-green wrapper the EVAL harness uses; the
 * interactive CLI composes the same `turn.ts` primitives via `Session`.
 */
function scoutSeed(
  opts: IRunOptions,
  tsService: Parameters<typeof buildScoutContext>[0],
  cwd: string,
  editable: readonly IFileView[],
  hasExistingCode: boolean
): string {
  // Opt-in, brownfield-only (a from-scratch build has no callers to map). Kept out
  // of runTask so its branch doesn't add to that function's complexity.
  if (opts.scout !== true || !hasExistingCode) {
    return "";
  }

  return buildScoutContext(tsService, cwd, editable);
}

/**
 * Validate the goalpost up front. RED-first: the gate must fail before we build,
 * so a no-op can't pass for success — UNLESS `requireRed` is false (greenfield,
 * where the global gate is a guardrail, not the per-feature signal). Returns the
 * gate result plus an `early` run result to stop on (already green + RED required),
 * or `early: null` to proceed (after reporting the RED event).
 */
async function redPrecheck(
  task: ITask,
  cwd: string,
  parse: ErrorParser | undefined,
  requireRed: boolean,
  report: Reporter
): Promise<{ red: IValidateResult; early: IRunResult | null }> {
  const red = await validate(task, cwd, parse);

  if (red.passed && requireRed) {
    report({
      kind: "done",
      task: task.id,
      cycles: 0,
      message: `task ${task.id}: already green`,
    });

    return {
      red,
      early: {
        task: task.id,
        redConfirmed: false,
        status: RUN_STATUS.redNotConfirmed,
        cycles: 0,
        edits: 0,
        regressions: 0,
      },
    };
  }

  report({
    kind: "red",
    task: task.id,
    errors: red.errors.length,
    // Carry the failing rule codes so the memory miner can seed the baseline
    // failure set — a one-turn red→green fix has no prior `validated` event.
    rules: red.errors.flatMap((e) => (e.rule === undefined ? [] : [e.rule])),
    message: `task ${task.id}: RED (${red.errors.length} error(s))`,
  });

  return { red, early: null };
}

export async function runTask(
  task: ITask,
  cwd: string,
  provider: IProvider,
  opts: IRunOptions = {}
): Promise<IRunResult> {
  const { parse, enableThinking, thinkingTokenBudget } = opts;
  const effectiveParse = effectiveParserFor(parse);
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const maxTurns = opts.maxTurns ?? LOOP_LIMITS.maxTurns;
  // Buffer every event so the post-run memory hook can mine the run for
  // failure→fix lessons, while still forwarding live to the real reporter.
  const base: Reporter = opts.onEvent ?? (() => undefined);
  const events: ILoopEvent[] = [];

  const report: Reporter = (event) => {
    events.push(event);
    base(event);
  };

  // Unique per run, so re-running the same task counts as a distinct session for
  // the lesson-recurrence gate.
  const runId = `${task.id}-${Date.now().toString(36)}`;

  const finish = async (result: IRunResult): Promise<IRunResult> => {
    await consolidateLessons(cwd, events, runId, report);

    return result;
  };

  report({
    kind: "start",
    task: task.id,
    message: `task ${task.id}: checking current state`,
  });

  const requireRed = opts.requireRed ?? true;
  const { red, early } = await redPrecheck(
    task,
    cwd,
    effectiveParse,
    requireRed,
    report
  );

  if (early !== null) {
    return early;
  }

  // Detect stack once per run, early; tsforge.config.json may adjust it
  const { stackProfile, ruleOverrides, policy, conventions } =
    await resolveStackForRun(
      cwd,
      (message) => {
        report({ kind: "tool", task: task.id, message });
      },
      opts.profile
    );

  report({
    kind: "tool",
    task: task.id,
    message: `detected stack: ${stackProfile.name} (${stackProfile.reason})`,
  });

  const editable = await readFiles(cwd, task.files);
  const context = await readFiles(cwd, task.context ?? []);

  // Existing code to navigate? (editable files already have content). Only then
  // do the LSP nav tools earn their decision-surface cost — see toolsFor(). Also
  // gates the scratch-simplicity guidance (from-scratch builds only).
  const hasExistingCode = editable.some((f) => f.content.trim().length > 0);

  // Build the LanguageService once, up front: scout needs it to seed the prompt,
  // and the loop reuses it (don't build twice).
  const tsService = await buildTsService(cwd);
  const scout = scoutSeed(opts, tsService, cwd, editable, hasExistingCode);

  const messages: IChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt(hasExistingCode, stackProfile, conventions),
    },
    {
      role: "user",
      content: seedPrompt(task, editable, context, stackProfile, scout),
    },
  ];

  const tools = toolsFor(hasExistingCode);

  // Mode-aware reasoning cap: scratch tasks over-think unbounded, so default
  // them to the measured knee; existing-code runs stay uncapped (the cap hurts
  // navigation). An explicit opts.thinkingTokenBudget always wins.
  const effectiveThinkingBudget =
    thinkingTokenBudget ??
    (hasExistingCode ? undefined : LOOP_LIMITS.scratchThinkingBudget);

  const ttsrManager = await initTtsrManager(cwd, report, task.id);

  const ctx: ILoopCtx = {
    task,
    cwd,
    tsService,
    report,
    messages,
    // Config-driven policy applies to headless runs too (the critical denies
    // already do, mode-independent; this adds `policy.mode`/`rules`).
    tool: { touched: new Set<string>(), ...policyCtxFields(policy) },
    gate: {
      parse: effectiveParse,
      stackProfile,
      ruleOverrides:
        Object.keys(ruleOverrides).length > 0 ? ruleOverrides : undefined,
    },
  };
  const state: ILoopState = {
    prevGateErrors: red.errors,
    gateNoProgress: 0,
    bestErrorCount: Number.POSITIVE_INFINITY,
    noNewLow: 0,
    errorAge: new Map(),
    lastGateCount: -1,
    edits: 0,
    regressions: 0,
    ttsrInterrupts: 0,
  };
  const taskStart = performance.now();

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const turnStart = performance.now();

    report({
      kind: "cycle",
      task: task.id,
      cycle: turn,
      message: `task ${task.id} · turn ${turn}: asking model`,
    });

    ttsrManager?.resetBuffer();

    const res = await provider.complete(
      messages,
      completionOptionsFor({
        tools,
        temperature,
        enableThinking,
        thinkingTokenBudget: effectiveThinkingBudget,
        ttsrManager,
        report,
        taskId: task.id,
      })
    );

    messages.push({
      role: "assistant",
      content: res.content,
      toolCalls: res.toolCalls,
      ...(res.reasoning === undefined
        ? {}
        : { reasoningContent: res.reasoning }),
    });

    // Every model call advances cooldown accounting — including interrupted
    // ones, otherwise repeatGap rules mis-count after a TTSR retry.
    ttsrManager?.incrementTurnCount();

    // TTSR interrupts are checked BEFORE degeneration so corrective guidance
    // lands at the earliest point. If the TTSR retry itself degenerates, the
    // next iteration's degeneration check catches it.
    if (res.ttsrFired !== undefined) {
      handleTtsrInterrupt(
        res.ttsrFired,
        state,
        messages,
        report,
        task.id,
        turn,
        turnStart,
        taskStart,
        ttsrManager
      );

      // Continue to next turn without settling the gate
      continue;
    }

    const looped = handleDegeneration(res, ctx, state, {
      turn,
      turnStart,
      taskStart,
    });

    if (looped !== null) {
      return finish(looped);
    }

    const touchedEditable =
      res.toolCalls.length === 0
        ? false
        : await runToolCalls(res.toolCalls, ctx, state);

    // Settle the gate whenever the model stopped OR changed an editable file.
    // (A read-only turn neither finishes nor mutates — just loop again.)
    if (res.toolCalls.length === 0 || touchedEditable) {
      const settled = await settleGate(ctx, state, turn);

      emitTiming(report, task.id, turn, turnStart, taskStart);

      if (settled !== null) {
        return finish({
          ...settled,
          edits: state.edits,
          regressions: state.regressions,
        });
      }

      // Stopped with no tool call while still red → nudge it to act, not narrate.
      if (res.toolCalls.length === 0) {
        messages.push({ role: "user", content: NO_TOOL_CALL_NUDGE });
      }

      continue;
    }

    emitTiming(report, task.id, turn, turnStart, taskStart);
  }

  report({
    kind: "stuck",
    task: task.id,
    cycles: maxTurns,
    message: `task ${task.id}: stuck (hit ${maxTurns}-turn cap)`,
  });

  return finish({
    task: task.id,
    redConfirmed: true,
    status: RUN_STATUS.stuck,
    cycles: maxTurns,
    reason: STUCK_REASON.cap,
    edits: state.edits,
    regressions: state.regressions,
  });
}
