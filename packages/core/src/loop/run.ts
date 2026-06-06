import { join, basename, isAbsolute } from "node:path";
import type { ITask } from "../spec/types";
import type { IChatMessage, IProvider } from "../inference/types";
import { validate, type ErrorParser } from "../validate/validate";
import { parseEslintJson } from "../validate/parse";
import { runAccept } from "../validate/accept";
import { sameErrorSet, type ErrorSet } from "../validate/errors";
import { isInScope } from "../lib/scope";
import { readFiles, fileExists, type IFileView } from "../lib/files";
import { LIMITS } from "../constants";
import { flags } from "../config";
import { ruleHelp, idiomHints } from "./rule-docs";
import { executeTool } from "./execute-tool";
import { astGrepFix } from "./astgrep-fix";
import {
  EDIT_TOOL,
  CREATE_TOOL,
  RUN_TOOL,
  READ_TOOL,
  LSP_TOOLS,
  TOOL_NAME,
} from "../agent/tools";
import { TsService } from "../lsp/service";
import type { Reporter } from "./events";

/** Terminal status of a single task run — compare against these, not bare strings. */
export const RUN_STATUS = {
  done: "done",
  stuck: "stuck",
  redNotConfirmed: "red-not-confirmed",
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

/** Why a run gave up (only set when status is `stuck`). */
export const STUCK_REASON = {
  stalled: "stalled",
  cap: "cap",
} as const;

export type StuckReason = (typeof STUCK_REASON)[keyof typeof STUCK_REASON];

export interface IRunResult {
  task: string;
  /** The gate failed before we started (a real goalpost). */
  redConfirmed: boolean;
  status: RunStatus;
  /** Model turns used. */
  cycles: number;
  reason?: StuckReason;
  /** Edits/creates applied to editable files (measure edit churn). */
  edits?: number;
  /** Times an edit RAISED the gate error count (regressions — measure churn quality). */
  regressions?: number;
}

export interface IRunOptions {
  parse?: ErrorParser;
  onEvent?: Reporter;
  temperature?: number;
  /** Per-request thinking toggle passed to the provider. */
  enableThinking?: boolean;
  /** Cap reasoning tokens per model call (vLLM `thinking_token_budget`). */
  thinkingTokenBudget?: number;
  /** Hard backstop on model turns (default 40). */
  maxTurns?: number;
}

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
  const maxTurns = opts.maxTurns ?? LIMITS.maxTurns;
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

      if (gateNoProgress >= LIMITS.gateStuckRepeats) {
        report({
          kind: "stuck",
          task: task.id,
          cycles: turn,
          message: `task ${task.id}: stuck (gate unchanged ${LIMITS.gateStuckRepeats}x)`,
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

const SYSTEM = [
  "You are an expert TypeScript engineer working inside tsforge, a harness specialized for STRICT TypeScript. Implement the task by editing code until the gate passes.",
  "Tools: `read` (inspect a file), `edit` (replace an exact, unique snippet), `create` (a new file), `run` (execute any shell command and see its output).",
  "Lead with action: write the implementation FIRST (one `create`/`edit`) — do NOT deliberate at length before writing any code.",
  "After every edit the harness AUTOMATICALLY runs the gate and gives you the result (the errors + fix guidance for the failing rules). You do NOT need to run the acceptance command yourself — read that result and fix exactly what it reports, then edit again. Keep going until it reports green; the harness ends the task at that point.",
  "Test hypotheses by RUNNING them, never by reasoning them out. Unsure about an edge case, rounding, or ordering (`Math.floor(100/3)`, largest-remainder ties)? `run` a quick `bun -e '…console.log(…)'`, or write a throwaway `scratch/check.ts` importing your impl and `run` it. `scratch/` is yours — the gate ignores it.",
  "The gate is `tsc` strict + eslint with every rule an error, so write TypeScript that satisfies it: interfaces are `I`-prefixed; `===`; no `var`; never the non-null `!` — guard index access (`const x = arr[i]; if (x === undefined) {...}`); no `any` and no `as` — type every parameter (e.g. `.reduce((acc: number, r: number) => …, 0)`); explicit boolean conditions. When the gate flags errors in read-only files (tests/types), they come from your editable file being missing or wrong-shaped and vanish once it's correct — don't edit them.",
].join("\n");

/** Exported symbol names in a file (lightweight regex — for the project map). */
export function exportedSymbols(content: string): string[] {
  const names = new Set<string>();
  const decl =
    /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;

  for (const m of content.matchAll(decl)) {
    if (m[1] !== undefined) {
      names.add(m[1]);
    }
  }

  for (const m of content.matchAll(/export\s*\{([^}]*)\}/g)) {
    const inner = m[1];

    if (inner === undefined) {
      continue;
    }

    for (const part of inner.split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();

      if (name !== undefined && name.length > 0) {
        names.add(name);
      }
    }
  }

  return [...names];
}

/** A compact map: `path (N lines) — exports: A, B`, one per file. */
function projectMap(views: readonly IFileView[]): string {
  return views
    .map((v) => {
      const lines = v.content.split("\n").length;
      const ex = exportedSymbols(v.content);

      return `  ${v.path} (${String(lines)} lines)${ex.length > 0 ? ` — exports: ${ex.join(", ")}` : ""}`;
    })
    .join("\n");
}

/**
 * Render a set of files for the prompt: full contents when small, a navigable
 * MAP when the combined size exceeds LIMITS.mapThresholdChars (the model then uses
 * read/search/symbol_search to inspect specifics). Exported for testing.
 */
export function renderFileSection(views: readonly IFileView[]): {
  text: string;
  mapped: boolean;
} {
  const total = views.reduce((n, v) => n + v.content.length, 0);

  if (total > LIMITS.mapThresholdChars) {
    return { text: projectMap(views), mapped: true };
  }

  return {
    text: views.map((v) => `File ${v.path}:\n${v.content}`).join("\n\n"),
    mapped: false,
  };
}

function seedPrompt(
  task: ITask,
  editable: IFileView[],
  context: IFileView[]
): string {
  const intent =
    task.intent !== undefined && task.intent.length > 0
      ? `Spec contract — implement EXACTLY this:\n${task.intent}`
      : "";

  const ed = renderFileSection(editable);
  const editableText =
    editable.length === 0
      ? "(none of the editable files exist yet — create them)"
      : ed.mapped
        ? `The editable files are large — here is a MAP (path · lines · exports). INSPECT specifics with read/search/symbol_search/find_references before editing; don't guess:\n${ed.text}`
        : ed.text;

  const ctx = context.length > 0 ? renderFileSection(context) : null;
  const contextText =
    ctx === null
      ? ""
      : `Read-only context (do NOT edit)${ctx.mapped ? " — MAP; read specifics on demand" : ""}:\n${ctx.text}`;

  return [
    `Task ${task.id}.`,
    intent,
    `Acceptance command (run this to verify — it must exit 0): ${task.accept}`,
    `Editable files: ${task.files.join(", ")}`,
    `Current editable contents:\n${editableText}`,
    contextText,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/** Cap rendered source lines so a large error set can't wall the model. */
const FEEDBACK_MAX_LINES = 20;

/**
 * Gate failures the model can act on (its editable files), each rendered WITH
 * its location and the offending source line — so the model fixes the exact
 * spot instead of reading the file and hand-counting to find it (which it did
 * for 3 turns on `money` when feedback was message-only). Plus the rules' fix
 * examples. Async because it reads the source lines from disk.
 */
export async function gateFeedback(
  errors: ErrorSet,
  task: ITask,
  cwd: string
): Promise<string> {
  const own = errors.filter(
    (e) =>
      e.file === undefined ||
      isInScope(e.file, task.files) ||
      isInScope(basename(e.file), task.files)
  );
  const readOnly = errors.length - own.length;

  const list =
    own.length > 0
      ? await renderErrors(own.slice(0, FEEDBACK_MAX_LINES), cwd)
      : "(no failures in your editable files)";
  const capped =
    own.length > FEEDBACK_MAX_LINES
      ? `\n… and ${own.length - FEEDBACK_MAX_LINES} more — fix the above first.`
      : "";

  const note =
    readOnly > 0
      ? `\n(${readOnly} other error(s) are in read-only files — not yours to fix; they resolve once your files are correct.)`
      : "";

  const help = ruleHelp(own);
  const helpBlock =
    help.length > 0 ? `\n\nHow to satisfy the gate:\n${help}` : "";

  const sources = await readFiles(cwd, task.files);
  const idioms = idiomHints(
    sources.map((s) => s.content),
    own
  );
  const idiomBlock =
    idioms.length > 0 ? `\n\nWatch for these strict-TS idioms:\n${idioms}` : "";

  // Tool-use lapse guard: if an editable file doesn't exist, the model likely
  // wrote the code as message TEXT instead of calling `create`. Code in your
  // reply is NEVER applied — only tool calls touch disk. Say so explicitly.
  const present = new Set(sources.map((s) => s.path));
  const missing = task.files.filter((f) => !present.has(f));
  const missingBlock =
    missing.length > 0
      ? `\n\n⚠ These editable files do NOT exist yet: ${missing.join(", ")}. ` +
        "Code written in your message text is NOT applied — you MUST call the " +
        "`create` tool with the file path and full content."
      : "";

  return `The acceptance command still fails:\n${list}${capped}${note}${helpBlock}${idiomBlock}${missingBlock}\n\nFix your editable files and run it again.`;
}

/**
 * Render each error as `- file:line [rule] message` followed by the offending
 * source line, so the model sees the exact code to change. Reads each file once
 * (cached); falls back to the bare message when there's no location.
 */
async function renderErrors(errors: ErrorSet, cwd: string): Promise<string> {
  const sources = new Map<string, string[]>();

  const linesOf = async (file: string): Promise<string[]> => {
    const cached = sources.get(file);

    if (cached !== undefined) {
      return cached;
    }

    const abs = isAbsolute(file) ? file : join(cwd, file);
    const handle = Bun.file(abs);
    const lines = (await handle.exists())
      ? (await handle.text()).split("\n")
      : [];

    sources.set(file, lines);

    return lines;
  };

  const rendered: string[] = [];

  for (const e of errors) {
    const loc =
      e.file !== undefined && e.line !== undefined
        ? `${basename(e.file)}:${e.line} `
        : "";
    const rule = e.rule !== undefined ? `[${e.rule}] ` : "";
    const head = `- ${loc}${rule}${e.message}`;

    if (e.file !== undefined && e.line !== undefined) {
      const src = (await linesOf(e.file))[e.line - 1];

      if (src !== undefined && src.trim().length > 0) {
        rendered.push(`${head}\n      ${e.line} │ ${src.trim()}`);
        continue;
      }
    }

    rendered.push(head);
  }

  return rendered.join("\n");
}
