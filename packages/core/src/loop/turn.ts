import { join } from "node:path";
import type { ITask } from "../spec";
import type { IChatMessage, IToolCall } from "../inference";
import {
  validate,
  runAccept,
  sameErrorSet,
  type ErrorParser,
  type ErrorSet,
} from "../validate";
import { isInScope } from "../lib/scope";
import { fileExists } from "../lib/fs";
import { RUN_STATUS, STUCK_REASON, LOOP_LIMITS } from "./loop.constants";
import type { IRunResult, Reporter } from "./loop.types";
import { flags } from "../config";
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
  fileArg,
} from "../agent";
import { TsService } from "../lsp";

/**
 * The shared turn primitives — one tool-using-conversation step and the
 * deterministic gate that confirms "done". Both drivers compose these: `runTask`
 * (the RED-first, drive-to-green eval wrapper in run.ts) and the interactive
 * `Session` (the CLI's persistent conversation). Keeping them here means there is
 * exactly ONE turn-loop and ONE gate, never two implementations to drift apart.
 */

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
export const NO_TOOL_CALL_NUDGE =
  "You replied with text but called no tool. Writing code or a plan in your " +
  "message does NOT change any file. Don't describe the next step — emit the " +
  "actual tool call now (create/edit to change a file, read/search to inspect one).";

/** A build turn ended with the model writing whole files INTO its chat message
 *  (fenced code blocks) instead of calling `create` — the narrate-instead-of-build
 *  failure. A chat message is never written to disk, so this nudges it to act. */
export const BUILD_NUDGE =
  "STOP — you wrote file contents in your message, but that does NOT create any " +
  "files on disk and cannot run. Write them for real now: call `create` once per " +
  "file (relative path + full contents), ONE file per call, starting with the " +
  "first. Do not paste code into your reply again — emit the create tool call.";

/** The coordinator's per-task working context (immutable inputs). */
export interface ILoopCtx {
  task: ITask;
  cwd: string;
  tsService: TsService | null;
  parse: ErrorParser | undefined;
  report: Reporter;
  messages: IChatMessage[];
  /** When set, the gate's command output is streamed here live (the CLI wires
   *  this so a slow gate like `vite build` + browser isn't silent dead air).
   *  Omitted on the eval path, where output is just captured for scoring. */
  onGateChunk?: (text: string) => void;
  /** Cancellation for the in-flight turn — threaded into tool `run` commands and
   *  the gate so a Ctrl-C (or a kill-timeout) reaches the child processes, not
   *  just the model call. Set per-send by the Session. */
  signal?: AbortSignal;
}

/** Mutable state threaded across turns (the gradient the loop descends). */
export interface ILoopState {
  prevGateErrors: ErrorSet;
  gateNoProgress: number;
  lastGateCount: number;
  edits: number;
  regressions: number;
}

/** Build the in-process TS LanguageService if the project has a tsconfig. Guarded
 *  so a setup failure can't break the loop (the `tsc -p` gate stays authority). */
export async function buildTsService(cwd: string): Promise<TsService | null> {
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
export async function runToolCalls(
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

    // Resolve the path the SAME way execution does (fileArg accepts the `path`/
    // `filename`/… aliases the model reaches for). Reading `call.arguments.file`
    // directly here would miss a `create({ path })` that DID write to disk — the
    // session would then think nothing changed and skip the gate. See P1 review.
    const file = fileArg(call.arguments);

    if (
      (call.name === TOOL_NAME.edit || call.name === TOOL_NAME.create) &&
      file !== null &&
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
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
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
    await runAccept(
      { ...task, accept: task.fix },
      cwd,
      ctx.signal === undefined ? {} : { signal: ctx.signal }
    );
  }

  const recheck = await validate(
    task,
    cwd,
    parse,
    ctx.signal === undefined ? {} : { signal: ctx.signal }
  );

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
export async function settleGate(
  ctx: ILoopCtx,
  state: ILoopState,
  turn: number
): Promise<IRunResult | null> {
  const { task, cwd, parse, report, messages } = ctx;

  await applyDeterministicFixes(ctx);

  if (task.fix !== undefined && task.fix.length > 0) {
    await runAccept(
      { ...task, accept: task.fix },
      cwd,
      ctx.signal === undefined ? {} : { signal: ctx.signal }
    );
  }

  if (ctx.onGateChunk !== undefined) {
    report({
      kind: "tool",
      task: task.id,
      message: `⚙ running gate · turn ${turn}…`,
    });
  }

  const gate = await validate(task, cwd, parse, {
    ...(ctx.onGateChunk === undefined ? {} : { onChunk: ctx.onGateChunk }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });

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
export function emitTiming(
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
