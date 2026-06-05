import { join, basename, isAbsolute } from "node:path";
import type { ITask } from "../spec/types";
import type { IChatMessage, IProvider } from "../inference/types";
import { validate, type ErrorParser } from "../validate/validate";
import { runAccept } from "../validate/accept";
import { sameErrorSet, type ErrorSet } from "../validate/errors";
import { isInScope } from "../lib/scope";
import { ruleHelp, idiomHints } from "./rule-docs";
import { executeTool } from "./execute-tool";
import { EDIT_TOOL, CREATE_TOOL, RUN_TOOL, READ_TOOL } from "../agent/tools";
import { TsService } from "../lsp/service";
import type { Reporter } from "./events";

export type RunStatus = "done" | "stuck" | "red-not-confirmed";

export interface IRunResult {
  task: string;
  /** The gate failed before we started (a real goalpost). */
  redConfirmed: boolean;
  status: RunStatus;
  /** Model turns used. */
  cycles: number;
  reason?: "stalled" | "cap";
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

const TOOLS = [READ_TOOL, RUN_TOOL, EDIT_TOOL, CREATE_TOOL];
/**
 * Give up only when the gate shows the EXACT same errors this many times in a
 * row — genuine spinning. Tuned for per-edit gating (the harness now validates
 * after every edit, so this counts edits, not stops): a hard error often needs
 * several attempts, so keep it generous. The 40-turn cap is the real backstop.
 */
const GATE_STUCK_LIMIT = 10;

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
  const temperature = opts.temperature ?? 0;
  const maxTurns = opts.maxTurns ?? 40;
  const report: Reporter = opts.onEvent ?? (() => undefined);

  report({
    kind: "start",
    task: task.id,
    message: `task ${task.id}: checking current state`,
  });

  // RED: the goalpost must fail before we build.
  const red = await validate(task, cwd, parse);

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
      status: "red-not-confirmed",
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

  // In-process TypeScript LanguageService for deterministic quick-fixes — built
  // once if the project has a tsconfig. Guarded so a setup failure can't break
  // the loop (the `tsc -p` gate stays the authority regardless).
  let tsService: TsService | null = null;

  try {
    if (await Bun.file(join(cwd, "tsconfig.json")).exists()) {
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
      tools: TOOLS,
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

        for (const f of task.files) {
          tsService.refresh(f);
          tsFixed += tsService.fixAll(f);
        }

        if (tsFixed > 0) {
          report({
            kind: "tool",
            task: task.id,
            message: `tsFixAll: applied ${tsFixed} TypeScript quick-fix(es)`,
          });
        }
      }

      if (task.fix !== undefined && task.fix.length > 0) {
        await runAccept({ ...task, accept: task.fix }, cwd);
      }

      const gate = await validate(task, cwd, parse);

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
          status: "done",
          cycles: turn,
        };
      }

      gateNoProgress = sameErrorSet(prevGateErrors, gate.errors)
        ? gateNoProgress + 1
        : 0;
      prevGateErrors = gate.errors;

      if (gateNoProgress >= GATE_STUCK_LIMIT) {
        report({
          kind: "stuck",
          task: task.id,
          cycles: turn,
          message: `task ${task.id}: stuck (gate unchanged ${GATE_STUCK_LIMIT}x)`,
        });

        return {
          task: task.id,
          redConfirmed: true,
          status: "stuck",
          cycles: turn,
          reason: "stalled",
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
        (call.name === "edit" || call.name === "create") &&
        typeof file === "string" &&
        isInScope(file, task.files)
      ) {
        touchedEditable = true;
        edits += 1;
      }

      const result = await executeTool(call, {
        cwd,
        files: task.files,
        report,
        task: task.id,
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
    status: "stuck",
    cycles: maxTurns,
    reason: "cap",
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

function seedPrompt(
  task: ITask,
  editable: { path: string; content: string }[],
  context: { path: string; content: string }[]
): string {
  const intent =
    task.intent !== undefined && task.intent.length > 0
      ? `Spec contract — implement EXACTLY this:\n${task.intent}`
      : "";

  const editableText =
    editable.length > 0
      ? editable.map((f) => `File ${f.path}:\n${f.content}`).join("\n\n")
      : "(none of the editable files exist yet — create them)";

  const contextText =
    context.length > 0
      ? `Read-only context (do NOT edit):\n${context
          .map((f) => `File ${f.path}:\n${f.content}`)
          .join("\n\n")}`
      : "";

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

  return `The acceptance command still fails:\n${list}${capped}${note}${helpBlock}${idiomBlock}\n\nFix your editable files and run it again.`;
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

async function readFiles(
  cwd: string,
  paths: string[]
): Promise<{ path: string; content: string }[]> {
  const views: { path: string; content: string }[] = [];

  for (const path of paths) {
    const file = Bun.file(join(cwd, path));

    if (await file.exists()) {
      views.push({ path, content: await file.text() });
    }
  }

  return views;
}
