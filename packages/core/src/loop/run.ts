import { join } from "node:path";
import type { ITask } from "../spec";
import type { IChatMessage, IProvider, IToolCall } from "../inference";
import {
  validate,
  type ErrorParser,
  sameErrorSet,
  type ErrorSet,
} from "../validate";
import { parseEslintJson, runAccept } from "../validate";
import { isInScope } from "../lib/scope";
import { readFiles, fileExists } from "../lib/fs";
import { RUN_STATUS, STUCK_REASON, LOOP_LIMITS } from "./loop.constants";
import type { IRunResult, IRunOptions, Reporter } from "./loop.types";
import { flags } from "../config";
import { SYSTEM, seedPrompt } from "./prompt";
import { gateFeedback } from "./feedback";
import { executeTool } from "./tools";
import { astGrepFix, dropRedundantAnnotations } from "./astgrep-fix";
import {
  EDIT_TOOL,
  CREATE_TOOL,
  RUN_TOOL,
  READ_TOOL,
  LSP_TOOLS,
  TOOL_NAME,
} from "../agent";
import { TsService } from "../lsp";

// The base tools the model always has, plus the semantic LSP/search tools
// (rename/type_at/find_references/symbol_search/diagnostics/organize_imports/
// search). The LSP set is for NAVIGATING an existing codebase. Measured (money
// vs react-board, 2026-06-06): handing the 7 nav tools to a SCRATCH create-from-
// spec task DILUTES the create path — the small model narrates/explores
// ("let me check existing files…") instead of emitting `create`, and stalls.
// react-board (existing code) used them cleanly. So gate them on whether there
// is existing code to navigate. TSFORGE_NO_LSP_TOOLS=1 forces them off entirely.
const BASE_TOOLS = [READ_TOOL, RUN_TOOL, EDIT_TOOL, CREATE_TOOL];

const ALL_TOOLS = [...BASE_TOOLS, ...LSP_TOOLS];

export function toolsFor(hasExistingCode: boolean): typeof ALL_TOOLS {
  if (flags.noLspTools() || !hasExistingCode) {
    return BASE_TOOLS;
  }

  return ALL_TOOLS;
}

/** The model wrote prose but issued NO tool call while the gate is still red —
 *  a narration-without-action turn (seen on money + react-board). Nudge it to ACT. */
const NO_TOOL_CALL_NUDGE =
  "You replied with text but called no tool. Writing code or a plan in your " +
  "message does NOT change any file. Don't describe the next step — emit the " +
  "actual tool call now (create/edit to change a file, read/search to inspect one).";

/** The coordinator's per-task working context (immutable inputs). */
interface ILoopCtx {
  task: ITask;
  cwd: string;
  tsService: TsService | null;
  parse: ErrorParser | undefined;
  report: Reporter;
  messages: IChatMessage[];
}

/** Mutable state threaded across turns (the gradient the loop descends). */
interface ILoopState {
  prevGateErrors: ErrorSet;
  gateNoProgress: number;
  lastGateCount: number;
  edits: number;
  regressions: number;
}

/**
 * The implement loop as a persistent, tool-using conversation. The model drives
 * — it can `read`, `run` (tests/tsc/eslint), `edit`, `create` — and the whole
 * conversation is retained as memory. When it stops calling tools (believes it's
 * done), the harness runs the deterministic gate, which is the ONLY authority on
 * "done": green ⇒ finished; red ⇒ the errors go back into the conversation and it
 * continues. It can't fake completion.
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

  const editable = await readFiles(cwd, task.files);
  const context = await readFiles(cwd, task.context ?? []);
  const messages: IChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: seedPrompt(task, editable, context) },
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

/** Build the in-process TS LanguageService if the project has a tsconfig. Guarded
 *  so a setup failure can't break the loop (the `tsc -p` gate stays authority). */
async function buildTsService(cwd: string): Promise<TsService | null> {
  try {
    if (await fileExists(cwd, "tsconfig.json")) {
      return new TsService(cwd);
    }
  } catch {
    // degrade silently — the gate runs regardless
  }

  return null;
}

/**
 * Run the model's tool calls: execute each, feed the result back, and report
 * whether any touched an editable file (which means we should re-gate). Mutates
 * `state.edits`. The semantic WRITE tools (rename/organize) also touch disk.
 */
async function runToolCalls(
  toolCalls: readonly IToolCall[],
  ctx: ILoopCtx,
  state: ILoopState
): Promise<boolean> {
  let touchedEditable = false;

  for (let i = 0; i < toolCalls.length; i += 1) {
    const call = toolCalls[i];

    if (call === undefined) {
      continue;
    }

    const file = call.arguments.file;

    if (
      (call.name === TOOL_NAME.edit || call.name === TOOL_NAME.create) &&
      typeof file === "string" &&
      isInScope(file, ctx.task.files)
    ) {
      touchedEditable = true;
      state.edits += 1;
    }

    if (
      call.name === TOOL_NAME.renameSymbol ||
      call.name === TOOL_NAME.organizeImports
    ) {
      touchedEditable = true;
    }

    const result = await executeTool(call, {
      cwd: ctx.cwd,
      files: ctx.task.files,
      report: ctx.report,
      task: ctx.task.id,
      tsService: ctx.tsService,
    });

    ctx.messages.push({
      role: "tool",
      content: result,
      toolCallId: call.id ?? `call_${i}`,
    });
  }

  return touchedEditable;
}

/**
 * Deterministic auto-fixes applied before the gate — mechanical fixes the model
 * shouldn't burn turns on. TypeScript's own safe quick-fixes (missing imports,
 * unused) + ast-grep SAFE idiom rewrites (`new Array(n).fill` → `Array.from`).
 * The `tsc -p` gate re-validates, so a bad fix can't ship; never throws.
 */
async function applyDeterministicFixes(ctx: ILoopCtx): Promise<void> {
  const { task, cwd, tsService, report } = ctx;

  if (tsService !== null) {
    let tsFixed = 0;

    for (const f of task.files) {
      try {
        if (await fileExists(cwd, f)) {
          tsService.refresh(f);
          tsFixed += tsService.fixAll(f);
        }
      } catch {
        // degrade silently — the gate still runs below
      }
    }

    if (tsFixed > 0) {
      report({
        kind: "tool",
        task: task.id,
        message: `tsFixAll: applied ${tsFixed} TypeScript quick-fix(es)`,
      });
    }
  }

  if (flags.noAstgrep()) {
    return;
  }

  let astFixed = 0;

  for (const f of task.files) {
    try {
      if (await fileExists(cwd, f)) {
        astFixed += await astGrepFix(join(cwd, f));
      }
    } catch {
      // degrade silently — gate is the authority
    }
  }

  if (astFixed > 0) {
    report({
      kind: "tool",
      task: task.id,
      message: `astGrepFix: applied ${astFixed} idiom rewrite(s)`,
    });
  }
}

/**
 * On a GREEN task, strip the redundant `const` annotations no stock lint rule
 * catches (over-annotation of call/expression-initialized locals) — then re-gate
 * and REVERT the whole file if anything regressed. Verified-safe: the structural
 * rewrite only sticks when the full gate (incl. prettier --check) stays green,
 * so a drop that changed an inferred type can never ship. Runs once, on the turn
 * the task goes green; a no-op when ast-grep is off or nothing is redundant.
 */
async function polishOnGreen(ctx: ILoopCtx): Promise<void> {
  const { task, cwd, parse, report } = ctx;

  if (flags.noAstgrep()) {
    return;
  }

  const snapshot = new Map<string, string>();

  for (const f of task.files) {
    if (await fileExists(cwd, f)) {
      snapshot.set(f, await Bun.file(join(cwd, f)).text());
    }
  }

  let dropped = 0;

  for (const f of task.files) {
    if (await fileExists(cwd, f)) {
      try {
        dropped += await dropRedundantAnnotations(join(cwd, f));
      } catch {
        // degrade silently — we revalidate and revert below
      }
    }
  }

  if (dropped === 0) {
    return;
  }

  // Re-format (the drop strips trailing semicolons) before re-gating.
  if (task.fix !== undefined && task.fix.length > 0) {
    await runAccept({ ...task, accept: task.fix }, cwd);
  }

  const recheck = await validate(task, cwd, parse);

  if (recheck.passed) {
    report({
      kind: "tool",
      task: task.id,
      message: `polish: dropped ${dropped} redundant annotation(s)`,
    });

    return;
  }

  // A drop changed an inferred type — roll the whole file set back to green.
  for (const [f, content] of snapshot) {
    await Bun.write(join(cwd, f), content);
  }
}

/**
 * The deterministic gate — the only authority on "done". Auto-fix, run the
 * optional fix command, validate, and return a terminal result (done/stuck) or
 * null to keep going (having fed the failures back into the conversation).
 */
async function settleGate(
  ctx: ILoopCtx,
  state: ILoopState,
  turn: number
): Promise<IRunResult | null> {
  const { task, cwd, parse, report, messages } = ctx;

  await applyDeterministicFixes(ctx);

  if (task.fix !== undefined && task.fix.length > 0) {
    await runAccept({ ...task, accept: task.fix }, cwd);
  }

  const gate = await validate(task, cwd, parse);

  if (state.lastGateCount >= 0 && gate.errors.length > state.lastGateCount) {
    state.regressions += 1;
  }

  state.lastGateCount = gate.errors.length;

  report({
    kind: "validated",
    task: task.id,
    cycle: turn,
    passed: gate.passed,
    errors: gate.errors.length,
    message: gate.passed
      ? `task ${task.id} · turn ${turn}: GREEN`
      : `task ${task.id} · turn ${turn}: red (${gate.errors.length} error(s))`,
  });

  if (gate.passed) {
    await polishOnGreen(ctx);

    report({
      kind: "done",
      task: task.id,
      cycles: turn,
      message: `task ${task.id}: done in ${turn} turn(s)`,
    });

    return {
      task: task.id,
      redConfirmed: true,
      status: RUN_STATUS.done,
      cycles: turn,
    };
  }

  state.gateNoProgress = sameErrorSet(state.prevGateErrors, gate.errors)
    ? state.gateNoProgress + 1
    : 0;
  state.prevGateErrors = gate.errors;

  if (state.gateNoProgress >= LOOP_LIMITS.gateStuckRepeats) {
    report({
      kind: "stuck",
      task: task.id,
      cycles: turn,
      message: `task ${task.id}: stuck (gate unchanged ${LOOP_LIMITS.gateStuckRepeats}x)`,
    });

    return {
      task: task.id,
      redConfirmed: true,
      status: RUN_STATUS.stuck,
      cycles: turn,
      reason: STUCK_REASON.stalled,
    };
  }

  messages.push({
    role: "user",
    content: await gateFeedback(gate.errors, task, cwd),
  });

  return null;
}

/** Report how long a turn took (and cumulative). */
function emitTiming(
  report: Reporter,
  task: string,
  turn: number,
  turnStart: number,
  taskStart: number
): void {
  const turnMs = Math.round(performance.now() - turnStart);
  const totalMs = Math.round(performance.now() - taskStart);

  report({
    kind: "timing",
    task,
    cycle: turn,
    ms: turnMs,
    message: `turn ${turn} took ${secs(turnMs)} (total ${secs(totalMs)})`,
  });
}

/** Human-readable duration: ms under a second, else seconds with one decimal. */
function secs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
