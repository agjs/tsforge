import type { ITask } from "../spec";
import type {
  IChatMessage,
  IModelResponse,
  IProvider,
  IToolCall,
} from "../inference";
import {
  validate,
  type ErrorParser,
  type IValidateResult,
  type IErrorItem,
} from "../validate";
import { readFiles, type IFileView } from "../lib/fs";
import { trace } from "../lib/trace";
import {
  DEFAULT_TEMPERATURE,
  RUN_STATUS,
  STUCK_REASON,
  LOOP_LIMITS,
  READONLY_STREAK_LIMIT,
  MAX_READONLY_RECOVERIES,
} from "./loop.constants";
import type {
  IRunResult,
  IRunOptions,
  Reporter,
  ILoopEvent,
  IHandoff,
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
import { resolveImageCapabilityFlags } from "./tools/image-tools";
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

  const errorMessages = state.prevGateErrors.map((e) => e.message);
  const handoff: IHandoff = {
    block: "degeneration",
    rungHistory: [],
    errors: errorMessages.slice(0, 3),
    ask: "model fell into a repetition loop and needs a different approach",
    resumable: true,
    resume: { triedLevers: [] },
  };

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
    reason: STUCK_REASON.handoff,
    detail: "degeneration",
    handoff,
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

/** Helper for readonly-spin limit reached: report the stuck state and return terminal result. */
function handleExhaustedRecoveries(args: {
  readonlyRecoveries: number;
  turn: number;
  report: Reporter;
  taskId: string;
  turnStart: number;
  taskStart: number;
  gateErrors: IErrorItem[];
}): { action: IRunResult; readonlyRecoveries: number } {
  const handoff: IHandoff = {
    block: "readonly-spin",
    rungHistory: [],
    errors: args.gateErrors.map((e) => e.message).slice(0, 3),
    ask: "model called only read-only tools without making progress toward the goal",
    resumable: true,
    resume: { triedLevers: [] },
  };

  args.report({
    kind: "stuck",
    task: args.taskId,
    cycles: args.turn,
    message:
      "⚠ model kept calling read-only tools without making progress after re-steering — stopped. Narrow the task or steer toward a concrete step.",
  });

  emitTiming(
    args.report,
    args.taskId,
    args.turn,
    args.turnStart,
    args.taskStart
  );

  return {
    action: {
      task: args.taskId,
      redConfirmed: true,
      status: RUN_STATUS.stuck,
      cycles: args.turn,
      reason: STUCK_REASON.handoff,
      detail: "readonly-spin",
      handoff,
      edits: 0,
      regressions: 0,
    },
    readonlyRecoveries: args.readonlyRecoveries,
  };
}

/** Helper for readonly-spin retry case: push steering message and return retry. */
function handleReadonlyRetry(args: {
  report: Reporter;
  taskId: string;
  messages: IChatMessage[];
  readonlyRecoveries: number;
}): { action: "retry"; readonlyRecoveries: number } {
  args.report({
    kind: "tool",
    task: args.taskId,
    message: "⚠ only reading, no edits — steering toward a concrete change",
  });

  args.messages.push({
    role: "user",
    content:
      "You have made many tool calls in a row WITHOUT writing any file — only reading " +
      "or searching. STOP exploring. Emit the SINGLE next change now: create or edit " +
      "ONE file to make concrete progress. No more reads. No prose.",
  });

  return {
    action: "retry",
    readonlyRecoveries: args.readonlyRecoveries + 1,
  };
}

/** Determine the action for readonly-spin guard: null to keep looping, "retry" to
 *  re-steer and continue with incremented recoveries, or an IRunResult to stop.
 *  Extracted to keep runTask under cognitive-complexity 20. */
function readonlySpinStop(args: {
  readonlyStreak: number;
  readonlyRecoveries: number;
  turn: number;
  report: Reporter;
  taskId: string;
  turnStart: number;
  taskStart: number;
  messages: IChatMessage[];
  gateErrors: IErrorItem[];
}): {
  action: IRunResult | "retry" | null;
  readonlyRecoveries: number;
} {
  if (args.readonlyStreak < READONLY_STREAK_LIMIT) {
    return { action: null, readonlyRecoveries: args.readonlyRecoveries };
  }

  if (args.readonlyRecoveries >= MAX_READONLY_RECOVERIES) {
    return handleExhaustedRecoveries({
      readonlyRecoveries: args.readonlyRecoveries,
      turn: args.turn,
      report: args.report,
      taskId: args.taskId,
      turnStart: args.turnStart,
      taskStart: args.taskStart,
      gateErrors: args.gateErrors,
    });
  }

  return handleReadonlyRetry({
    report: args.report,
    taskId: args.taskId,
    messages: args.messages,
    readonlyRecoveries: args.readonlyRecoveries,
  });
}

/** Process a tool-call turn: run the calls and apply read-only-spin guard. Returns
 *  the action to take (continue/retry/stop) and updated streak/recovery counters.
 *  Extracted to keep runTask under cognitive-complexity 20. */
async function processToolCallTurn(args: {
  toolCalls: readonly IToolCall[];
  ctx: ILoopCtx;
  state: ILoopState;
  readonlyStreak: number;
  readonlyRecoveries: number;
  turn: number;
  turnStart: number;
  taskStart: number;
}): Promise<{
  action: "continue" | "retry" | "check-gate" | IRunResult;
  readonlyStreak: number;
  readonlyRecoveries: number;
}> {
  const touchedEditable = await runToolCalls(
    args.toolCalls,
    args.ctx,
    args.state
  );

  // Read-only-spin guard: consecutive read-only turns without edits.
  if (touchedEditable) {
    return {
      action: "check-gate",
      readonlyStreak: 0,
      readonlyRecoveries: args.readonlyRecoveries,
    };
  }

  const updatedStreak = args.readonlyStreak + 1;
  const spin = readonlySpinStop({
    readonlyStreak: updatedStreak,
    readonlyRecoveries: args.readonlyRecoveries,
    turn: args.turn,
    report: args.ctx.report,
    taskId: args.ctx.task.id,
    turnStart: args.turnStart,
    taskStart: args.taskStart,
    messages: args.ctx.messages,
    gateErrors: args.state.prevGateErrors,
  });

  if (spin.action === "retry") {
    return {
      action: "retry",
      readonlyStreak: 0,
      readonlyRecoveries: spin.readonlyRecoveries,
    };
  }

  if (spin.action !== null) {
    return {
      action: spin.action,
      readonlyStreak: updatedStreak,
      readonlyRecoveries: spin.readonlyRecoveries,
    };
  }

  return {
    action: "continue",
    readonlyStreak: updatedStreak,
    readonlyRecoveries: args.readonlyRecoveries,
  };
}

/** Handle a model response: check TTSR/degeneration, run tools or settle gate.
 *  Returns the action to take (continue loop / stop with result) plus updated state.
 *  Extracted to reduce runMainLoop complexity. */
async function handleModelResponse(args: {
  res: IModelResponse;
  ctx: ILoopCtx;
  state: ILoopState;
  messages: IChatMessage[];
  readonlyStreak: number;
  readonlyRecoveries: number;
  turn: number;
  turnStart: number;
  taskStart: number;
  report: Reporter;
  taskId: string;
  ttsrManager: Awaited<ReturnType<typeof initTtsrManager>> | null;
  finish: (result: IRunResult) => Promise<IRunResult>;
}): Promise<{
  action: "continue" | IRunResult;
  readonlyStreak: number;
  readonlyRecoveries: number;
}> {
  // TTSR interrupt: continue without settling gate
  if (args.res.ttsrFired !== undefined) {
    handleTtsrInterrupt(
      args.res.ttsrFired,
      args.state,
      args.messages,
      args.report,
      args.taskId,
      args.turn,
      args.turnStart,
      args.taskStart,
      args.ttsrManager
    );

    return {
      action: "continue",
      readonlyStreak: args.readonlyStreak,
      readonlyRecoveries: args.readonlyRecoveries,
    };
  }

  // Degeneration check: terminal stuck
  const looped = handleDegeneration(args.res, args.ctx, args.state, {
    turn: args.turn,
    turnStart: args.turnStart,
    taskStart: args.taskStart,
  });

  if (looped !== null) {
    return {
      action: looped,
      readonlyStreak: args.readonlyStreak,
      readonlyRecoveries: args.readonlyRecoveries,
    };
  }

  // No tool calls: settle gate or nudge
  if (args.res.toolCalls.length === 0) {
    const settled = await settleGate(args.ctx, args.state, args.turn);

    emitTiming(
      args.report,
      args.taskId,
      args.turn,
      args.turnStart,
      args.taskStart
    );

    if (settled !== null) {
      return {
        action: settled,
        readonlyStreak: args.readonlyStreak,
        readonlyRecoveries: args.readonlyRecoveries,
      };
    }

    // Stopped with no tool call while still red → nudge it to act, not narrate.
    args.messages.push({ role: "user", content: NO_TOOL_CALL_NUDGE });

    return {
      action: "continue",
      readonlyStreak: args.readonlyStreak,
      readonlyRecoveries: args.readonlyRecoveries,
    };
  }

  // Tool calls: process with read-only-spin guard and possibly settle gate
  const tool = await processToolCallTurn({
    toolCalls: args.res.toolCalls,
    ctx: args.ctx,
    state: args.state,
    readonlyStreak: args.readonlyStreak,
    readonlyRecoveries: args.readonlyRecoveries,
    turn: args.turn,
    turnStart: args.turnStart,
    taskStart: args.taskStart,
  });

  // Re-steering: continue without gate
  if (tool.action === "retry") {
    return {
      action: "continue",
      readonlyStreak: tool.readonlyStreak,
      readonlyRecoveries: tool.readonlyRecoveries,
    };
  }

  // Terminal readonly-spin stop
  if (tool.action instanceof Object && "status" in tool.action) {
    return {
      action: {
        ...tool.action,
        edits: args.state.edits,
        regressions: args.state.regressions,
      },
      readonlyStreak: tool.readonlyStreak,
      readonlyRecoveries: tool.readonlyRecoveries,
    };
  }

  // Tool without edit: continue without gate
  if (tool.action === "continue") {
    emitTiming(
      args.report,
      args.taskId,
      args.turn,
      args.turnStart,
      args.taskStart
    );

    return {
      action: "continue",
      readonlyStreak: tool.readonlyStreak,
      readonlyRecoveries: tool.readonlyRecoveries,
    };
  }

  // Edited file: settle the gate
  const settled = await settleGate(args.ctx, args.state, args.turn);

  emitTiming(
    args.report,
    args.taskId,
    args.turn,
    args.turnStart,
    args.taskStart
  );

  if (settled !== null) {
    return {
      action: {
        ...settled,
        edits: args.state.edits,
        regressions: args.state.regressions,
      },
      readonlyStreak: tool.readonlyStreak,
      readonlyRecoveries: tool.readonlyRecoveries,
    };
  }

  return {
    action: "continue",
    readonlyStreak: tool.readonlyStreak,
    readonlyRecoveries: tool.readonlyRecoveries,
  };
}

/** The main turn loop: call the model repeatedly, handle responses with guard checks,
 *  and settle the gate. Returns the final run result. Extracted to keep runTask
 *  under cognitive-complexity 20. */
async function runMainLoop(args: {
  maxTurns: number;
  provider: IProvider;
  messages: IChatMessage[];
  tools: unknown[];
  temperature: number;
  enableThinking: boolean | undefined;
  thinkingTokenBudget: number | undefined;
  ttsrManager: Awaited<ReturnType<typeof initTtsrManager>> | null;
  report: Reporter;
  taskId: string;
  ctx: ILoopCtx;
  state: ILoopState;
  finish: (result: IRunResult) => Promise<IRunResult>;
}): Promise<IRunResult> {
  let readonlyStreak = 0;
  let readonlyRecoveries = 0;
  const taskStart = performance.now();

  for (let turn = 1; turn <= args.maxTurns; turn += 1) {
    const turnStart = performance.now();

    args.report({
      kind: "cycle",
      task: args.taskId,
      cycle: turn,
      message: `task ${args.taskId} · turn ${turn}: asking model`,
    });

    args.ttsrManager?.resetBuffer();

    const res = await args.provider.complete(
      args.messages,
      completionOptionsFor({
        tools: args.tools,
        temperature: args.temperature,
        enableThinking: args.enableThinking,
        thinkingTokenBudget: args.thinkingTokenBudget,
        ttsrManager: args.ttsrManager,
        report: args.report,
        taskId: args.taskId,
      })
    );

    args.messages.push({
      role: "assistant",
      content: res.content,
      toolCalls: res.toolCalls,
      ...(res.reasoning === undefined
        ? {}
        : { reasoningContent: res.reasoning }),
    });

    // Every model call advances cooldown accounting — including interrupted
    // ones, otherwise repeatGap rules mis-count after a TTSR retry.
    args.ttsrManager?.incrementTurnCount();

    // Handle the response (guard checks, tools, gate settle).
    const handled = await handleModelResponse({
      res,
      ctx: args.ctx,
      state: args.state,
      messages: args.messages,
      readonlyStreak,
      readonlyRecoveries,
      turn,
      turnStart,
      taskStart,
      report: args.report,
      taskId: args.taskId,
      ttsrManager: args.ttsrManager,
      finish: args.finish,
    });

    readonlyStreak = handled.readonlyStreak;
    readonlyRecoveries = handled.readonlyRecoveries;

    if (handled.action !== "continue") {
      return args.finish(handled.action);
    }
  }

  args.report({
    kind: "stuck",
    task: args.taskId,
    cycles: args.maxTurns,
    message: `task ${args.taskId}: stuck (hit ${args.maxTurns}-turn cap)`,
  });

  return args.finish({
    task: args.taskId,
    redConfirmed: true,
    status: RUN_STATUS.stuck,
    cycles: args.maxTurns,
    reason: STUCK_REASON.cap,
    edits: args.state.edits,
    regressions: args.state.regressions,
  });
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

  const caps = await resolveImageCapabilityFlags();
  const tools = toolsFor(hasExistingCode, caps);

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
    steerLevel: 0,
  };

  return await runMainLoop({
    maxTurns,
    provider,
    messages,
    tools,
    temperature,
    enableThinking,
    thinkingTokenBudget: effectiveThinkingBudget,
    ttsrManager,
    report,
    taskId: task.id,
    ctx,
    state,
    finish,
  });
}
