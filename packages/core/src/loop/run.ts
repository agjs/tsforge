import { join } from "node:path";
import type { ITask } from "../spec";
import type { IChatMessage, IModelResponse, IProvider } from "../inference";
import { validate, type ErrorParser } from "../validate";
import { parseEslintJson } from "../validate";
import { readFiles } from "../lib/fs";
import { RUN_STATUS, STUCK_REASON, LOOP_LIMITS } from "./loop.constants";
import type { IRunResult, IRunOptions, Reporter } from "./loop.types";
import { flags } from "../config";
import { SYSTEM, seedPrompt } from "./prompt";
import { detectStack } from "../stack-detection";
import { TtsrManager, parseProjectRules, type ITtsrRule } from "./ttsr";
import { DEFAULT_TTSR_RULES } from "./ttsr-defaults";
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

/** Read and parse `<cwd>/.tsforge/rules.json` if present. Missing or invalid
 *  files yield no rules (parseProjectRules tolerates malformed JSON). */
export async function loadProjectTtsrRules(cwd: string): Promise<ITtsrRule[]> {
  const file = Bun.file(join(cwd, ".tsforge", "rules.json"));

  if (!(await file.exists())) {
    return [];
  }

  return parseProjectRules(await file.text());
}

/** Build and configure a TTSR manager if enabled. Returns null if disabled.
 *  Built-in defaults register first, then optional project rules from
 *  `<cwd>/.tsforge/rules.json`; `addRule` ignores duplicate names, so a
 *  built-in safety rule always wins over a same-named project rule. */
export async function initTtsrManager(
  cwd: string,
  report: Reporter,
  taskId: string
): Promise<TtsrManager | null> {
  if (!flags.ttsr()) {
    return null;
  }

  const manager = new TtsrManager();

  for (const rule of DEFAULT_TTSR_RULES) {
    manager.addRule(rule);
  }

  let added = 0;

  for (const rule of await loadProjectTtsrRules(cwd)) {
    if (manager.addRule(rule)) {
      added += 1;
    }
  }

  if (added > 0) {
    report({
      kind: "ttsr",
      task: taskId,
      message: `loaded ${added} custom TTSR rule(s) from .tsforge/rules.json`,
    });
  }

  return manager;
}

/** Handle a TTSR interrupt: report, inject corrective message, and optionally disable. */
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
  state.ttsrInterrupts += 1;

  report({
    kind: "ttsr",
    task: taskId,
    message: `⚠ TTSR interrupted: ${ttsrFired.ruleName}`,
  });

  // Hard cap: after 3 interrupts, disable TTSR to prevent loops
  if (state.ttsrInterrupts >= 3) {
    report({
      kind: "tool",
      task: taskId,
      message: `TTSR disabled after ${state.ttsrInterrupts} interrupts (hit cap)`,
    });

    ttsrManager?.disable();
  }

  // Append corrective message and retry without counting as a normal cycle
  messages.push({
    role: "user",
    content: `⚠ generation interrupted: ${ttsrFired.guidance} Rewrite the affected part without that pattern.`,
  });

  emitTiming(report, taskId, turn, turnStart, taskStart);
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

/** A/B control for the gate-feedback-fidelity win: TSFORGE_LEGACY_FEEDBACK=1
 *  forces the OLD mis-selected parser (eslint-json on chained tsc&&eslint). */
function effectiveParserFor(
  parse: ErrorParser | undefined
): ErrorParser | undefined {
  return flags.legacyFeedback() ? parseEslintJson : parse;
}

/** Detect the stack and fold in tsforge.config.json pack/rule overrides, plus any
 *  rule packs from configured external plugins. */
async function resolveStackForRun(
  cwd: string,
  report: (message: string) => void
): Promise<{
  stackProfile: Awaited<ReturnType<typeof detectStack>>;
  ruleOverrides: Readonly<Record<string, "error" | "warn" | "off">>;
}> {
  const detectedProfile = await detectStack(cwd);
  const { loadTsforgeConfig, resolveActivePacks, normalizeRuleOverrides } =
    await import("../config/tsforge-config");
  const { loadAndRegisterPlugins } = await import("../config/external-plugins");
  const cfg = await loadTsforgeConfig(cwd);
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
export async function runTask(
  task: ITask,
  cwd: string,
  provider: IProvider,
  opts: IRunOptions = {}
): Promise<IRunResult> {
  const { parse, enableThinking, thinkingTokenBudget } = opts;
  const effectiveParse = effectiveParserFor(parse);
  const temperature = opts.temperature ?? 0;
  const maxTurns = opts.maxTurns ?? LOOP_LIMITS.maxTurns;
  const report: Reporter = opts.onEvent ?? (() => undefined);

  report({
    kind: "start",
    task: task.id,
    message: `task ${task.id}: checking current state`,
  });

  // RED: the goalpost must fail before we build.
  const red = await validate(task, cwd, effectiveParse);

  if (red.passed) {
    report({
      kind: "done",
      task: task.id,
      cycles: 0,
      message: `task ${task.id}: already green`,
    });

    return {
      task: task.id,
      redConfirmed: false,
      status: RUN_STATUS.redNotConfirmed,
      cycles: 0,
      edits: 0,
      regressions: 0,
    };
  }

  report({
    kind: "red",
    task: task.id,
    errors: red.errors.length,
    message: `task ${task.id}: RED (${red.errors.length} error(s))`,
  });

  // Detect stack once per run, early; tsforge.config.json may adjust it
  const { stackProfile, ruleOverrides } = await resolveStackForRun(
    cwd,
    (message) => {
      report({ kind: "tool", task: task.id, message });
    }
  );

  report({
    kind: "tool",
    task: task.id,
    message: `detected stack: ${stackProfile.name} (${stackProfile.reason})`,
  });

  const editable = await readFiles(cwd, task.files);
  const context = await readFiles(cwd, task.context ?? []);
  const messages: IChatMessage[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: seedPrompt(task, editable, context, stackProfile),
    },
  ];

  // Existing code to navigate? (editable files already have content). Only then
  // do the LSP nav tools earn their decision-surface cost — see toolsFor().
  const hasExistingCode = editable.some((f) => f.content.trim().length > 0);
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
    tsService: await buildTsService(cwd),
    parse: effectiveParse,
    report,
    messages,
    stackProfile,
    ruleOverrides:
      Object.keys(ruleOverrides).length > 0 ? ruleOverrides : undefined,
  };
  const state: ILoopState = {
    prevGateErrors: red.errors,
    gateNoProgress: 0,
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
      return looped;
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
        return {
          ...settled,
          edits: state.edits,
          regressions: state.regressions,
        };
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

  return {
    task: task.id,
    redConfirmed: true,
    status: RUN_STATUS.stuck,
    cycles: maxTurns,
    reason: STUCK_REASON.cap,
    edits: state.edits,
    regressions: state.regressions,
  };
}
