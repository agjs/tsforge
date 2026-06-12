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
  // A/B control for the gate-feedback-fidelity win: TSFORGE_LEGACY_FEEDBACK=1
  // forces the OLD mis-selected parser (eslint-json on chained tsc&&eslint).
  const effectiveParse: ErrorParser | undefined = flags.legacyFeedback()
    ? parseEslintJson
    : parse;
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

  // Detect stack once per run, early
  const stackProfile = await detectStack(cwd);

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

  const ctx: ILoopCtx = {
    task,
    cwd,
    tsService: await buildTsService(cwd),
    parse: effectiveParse,
    report,
    messages,
    stackProfile,
  };
  const state: ILoopState = {
    prevGateErrors: red.errors,
    gateNoProgress: 0,
    lastGateCount: -1,
    edits: 0,
    regressions: 0,
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

    const res = await provider.complete(messages, {
      tools,
      temperature,
      toolChoice: "auto",
      ...(enableThinking === undefined ? {} : { enableThinking }),
      ...(effectiveThinkingBudget === undefined
        ? {}
        : { thinkingTokenBudget: effectiveThinkingBudget }),
      onToken: (text) => {
        report({ kind: "token", task: task.id, message: text });
      },
    });

    messages.push({
      role: "assistant",
      content: res.content,
      toolCalls: res.toolCalls,
    });

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
