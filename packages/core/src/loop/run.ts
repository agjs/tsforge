import { join } from "node:path";
import type { ITask } from "../spec";
import type { IChatMessage, IProvider } from "../inference";
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
import { astGrepFix } from "./astgrep-fix";
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
  // forces the OLD mis-selected parser (eslint-json on chained tsc&&eslint), so
  // a tsc failure dumps as one opaque blob (maxErr=1, no structure/source-lines)
  // — the pre-fix behavior, to measure the lift with reps instead of n=1.
  const legacyFeedback = flags.legacyFeedback();
  const effectiveParse: ErrorParser | undefined = legacyFeedback
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

  // In-process TypeScript LanguageService for deterministic quick-fixes — built
  // once if the project has a tsconfig. Guarded so a setup failure can't break
  // the loop (the `tsc -p` gate stays the authority regardless).
  let tsService: TsService | null = null;

  try {
    if (await fileExists(cwd, "tsconfig.json")) {
      tsService = new TsService(cwd);
    }
  } catch {
    tsService = null;
  }

  let prevGateErrors: ErrorSet = red.errors;
  let gateNoProgress = 0;
  let edits = 0;
  let regressions = 0;
  let lastGateCount = -1;
  const taskStart = performance.now();

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const turnStart = performance.now();

    report({
      kind: "cycle",
      task: task.id,
      cycle: turn,
      message: `task ${task.id} · turn ${turn}: asking model`,
    });

    const emitTiming = (): void => {
      const turnMs = Math.round(performance.now() - turnStart);
      const totalMs = Math.round(performance.now() - taskStart);

      report({
        kind: "timing",
        task: task.id,
        cycle: turn,
        ms: turnMs,
        message: `turn ${turn} took ${secs(turnMs)} (total ${secs(totalMs)})`,
      });
    };

    const res = await provider.complete(messages, {
      tools,
      temperature,
      toolChoice: "auto",
      ...(enableThinking === undefined ? {} : { enableThinking }),
      ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
      onToken: (text) => {
        report({ kind: "token", task: task.id, message: text });
      },
    });

    messages.push({
      role: "assistant",
      content: res.content,
      toolCalls: res.toolCalls,
    });

    // The deterministic gate — the only authority on "done". Auto-fix, validate,
    // and return a terminal result (done/stuck) or null to keep going (having fed
    // the failures back to the model).
    const settleGate = async (): Promise<IRunResult | null> => {
      // Deterministic TS auto-fix: apply TypeScript's own safe quick-fixes
      // (missing imports, unused, etc.) to the editable files before the gate —
      // mechanical fixes the model shouldn't burn turns on.
      if (tsService !== null) {
        let tsFixed = 0;

        // Guard: only touch files that exist on disk, and never let a
        // LanguageService throw crash the run (the `tsc -p` gate is the
        // authority regardless). A not-yet-created editable file made
        // getSemanticDiagnostics throw "Could not find source file".
        for (const f of task.files) {
          try {
            if (!(await fileExists(cwd, f))) {
              continue;
            }

            tsService.refresh(f);
            tsFixed += tsService.fixAll(f);
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

      // Deterministic SAFE idiom rewrites via ast-grep (structural codemod) —
      // e.g. `new Array(n).fill(x)` → `Array.from(...)` (typed, not any[]). The
      // gate re-validates, so a bad rewrite can't ship. Never throws into the loop.
      // TSFORGE_NO_ASTGREP=1 disables it (A/B control: it mutates model code
      // mid-loop, which may or may not earn its keep — measure before trusting).
      let astFixed = 0;

      if (!flags.noAstgrep()) {
        for (const f of task.files) {
          try {
            if (await fileExists(cwd, f)) {
              astFixed += await astGrepFix(join(cwd, f));
            }
          } catch {
            // degrade silently — gate is the authority
          }
        }
      }

      if (astFixed > 0) {
        report({
          kind: "tool",
          task: task.id,
          message: `astGrepFix: applied ${astFixed} idiom rewrite(s)`,
        });
      }

      if (task.fix !== undefined && task.fix.length > 0) {
        await runAccept({ ...task, accept: task.fix }, cwd);
      }

      const gate = await validate(task, cwd, effectiveParse);

      if (lastGateCount >= 0 && gate.errors.length > lastGateCount) {
        regressions += 1;
      }

      lastGateCount = gate.errors.length;

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

      gateNoProgress = sameErrorSet(prevGateErrors, gate.errors)
        ? gateNoProgress + 1
        : 0;
      prevGateErrors = gate.errors;

      if (gateNoProgress >= LOOP_LIMITS.gateStuckRepeats) {
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
    };

    // No tool calls = the model stopped; settle the gate.
    if (res.toolCalls.length === 0) {
      const settled = await settleGate();

      emitTiming();

      if (settled !== null) {
        return { ...settled, edits, regressions };
      }

      // The model replied with prose but issued NO tool call while the gate is
      // still red — a narration-without-action turn that wastes wall-clock. Seen
      // on BOTH money ("I wrote the code in my message but didn't call create")
      // and react-board (a multi-turn "let me read the files…" loop). Nudge it to
      // ACT, not describe. Only fires on zero-tool-calls-while-red (a turn that
      // legitimately finishes ends green and returns above), so it can't push the
      // model to over-edit a passing task.
      messages.push({
        role: "user",
        content:
          "You replied with text but called no tool. Writing code or a plan in your message does NOT change any file. Don't describe the next step — emit the actual tool call now (create/edit to change a file, read/search to inspect one).",
      });

      continue;
    }

    // The model asked for tools — run each, feed results back, note whether it
    // changed an editable file.
    let touchedEditable = false;

    for (let i = 0; i < res.toolCalls.length; i += 1) {
      const call = res.toolCalls[i];

      if (call === undefined) {
        continue;
      }

      const file = call.arguments.file;

      if (
        (call.name === TOOL_NAME.edit || call.name === TOOL_NAME.create) &&
        typeof file === "string" &&
        isInScope(file, task.files)
      ) {
        touchedEditable = true;
        edits += 1;
      }

      // The semantic WRITE tools mutate editable files on disk too — re-gate.
      if (
        call.name === TOOL_NAME.renameSymbol ||
        call.name === TOOL_NAME.organizeImports
      ) {
        touchedEditable = true;
      }

      const result = await executeTool(call, {
        cwd,
        files: task.files,
        report,
        task: task.id,
        tsService,
      });

      messages.push({
        role: "tool",
        content: result,
        toolCallId: call.id ?? `call_${i}`,
      });
    }

    // Lever 1: after any edit to an editable file the HARNESS auto-runs the gate
    // and feeds the result back — so the model never burns a turn on a premature
    // "done" and need not run the acceptance command itself.
    if (touchedEditable) {
      const settled = await settleGate();

      emitTiming();

      if (settled !== null) {
        return { ...settled, edits, regressions };
      }

      continue;
    }

    emitTiming();
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
    edits,
    regressions,
  };
}

/** Human-readable duration: ms under a second, else seconds with one decimal. */
function secs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
