import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
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
import { fileExists, resolveScopeFiles } from "../lib/fs";
import { RUN_STATUS, STUCK_REASON, LOOP_LIMITS } from "./loop.constants";
import type { IRunResult, Reporter } from "./loop.types";
import { flags } from "../config";
import { gateFeedback } from "./feedback";
import { executeTool } from "./tools";
import {
  astGrepFix,
  dropRedundantAnnotations,
  stripLiteralCasts,
} from "./astgrep-fix";
import {
  EDIT_TOOL,
  CREATE_TOOL,
  RUN_TOOL,
  READ_TOOL,
  LSP_TOOLS,
  TOOL_NAME,
} from "../agent";
import { TsService, type ITsDiagnostic } from "../lsp";
import type { FileLinter, IFileLintProblem } from "../detect-gate";

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
  /** Write-time single-file linter (the gate's eslint rules, applied per write so
   *  moat violations tsc can't see surface inline). Omitted ⇒ type-only guard. */
  lintFile?: FileLinter;
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

/** Diagnostic codes that are EXPECTED noise mid-build, not real mistakes: 2307 =
 *  "cannot find module" (a sibling the model hasn't created yet in this batch). */
const TRANSIENT_DIAG_CODES = new Set<number>([2307]);

/** Max diagnostics surfaced per write — keep the in-band feedback tight. */
const MAX_WRITE_GUARD_DIAGS = 6;

/** Render the per-issue lines (type errors + lint problems), capped + ordered. */
function writeGuardLines(
  absPath: string,
  typeErrors: readonly ITsDiagnostic[],
  lintProblems: readonly IFileLintProblem[]
): string {
  let text = "";

  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    text = "";
  }

  const lineOf = (offset: number): number =>
    text.slice(0, offset).split("\n").length;
  const typeLines = typeErrors.map(
    (d) => `  L${String(lineOf(d.start))}: ${d.message} (TS${String(d.code)})`
  );
  const lintLines = lintProblems.map(
    (p) => `  L${String(p.line)}: ${p.message} (${p.ruleId})`
  );
  const all = [...typeLines, ...lintLines];
  const shown = all.slice(0, MAX_WRITE_GUARD_DIAGS).join("\n");
  const more =
    all.length > MAX_WRITE_GUARD_DIAGS
      ? `\n  …and ${String(all.length - MAX_WRITE_GUARD_DIAGS)} more`
      : "";

  return `${shown}${more}`;
}

/** Max dependant files (and errors each) to name in the blast-radius section. */
const MAX_DEP_FILES = 4;
const MAX_DEP_ERRORS = 2;

/**
 * Render the CROSS-FILE blast radius: the dependant files an edit broke, with the
 * first error(s) in each. Empty string when nothing downstream broke. This is the
 * write-guard reaching across the import graph (see TsService.dependantErrors).
 */
function dependantBlastRadius(
  dependants: readonly { file: string; errors: readonly ITsDiagnostic[] }[]
): string {
  if (dependants.length === 0) {
    return "";
  }

  const blocks = dependants.slice(0, MAX_DEP_FILES).map((d) => {
    let text = "";

    try {
      text = readFileSync(d.file, "utf8");
    } catch {
      text = "";
    }

    const lineOf = (offset: number): number =>
      text.slice(0, offset).split("\n").length;

    return d.errors
      .slice(0, MAX_DEP_ERRORS)
      .map(
        (e) =>
          `  ${basename(d.file)}:${String(lineOf(e.start))} ${e.message} (TS${String(e.code)})`
      )
      .join("\n");
  });
  const more =
    dependants.length > MAX_DEP_FILES
      ? `\n  …and ${String(dependants.length - MAX_DEP_FILES)} more file(s)`
      : "";

  return (
    `\n\n⚠ BLAST RADIUS — this change broke ${String(dependants.length)} file(s) that ` +
    `depend on it. Fix them too, or revert the change (e.g. a signature you altered):\n` +
    `${blocks.join("\n")}${more}`
  );
}

/**
 * WRITE-TIME GUARD: the moment the model writes a file, check JUST that file and
 * hand any real problems back AS THE TOOL RESULT — so the model fixes them THIS
 * turn, while the file is fresh, before building more on a broken foundation. Two
 * layers: (1) tsc diagnostics via the in-process language service (real type
 * errors); (2) the gate's eslint rules on this one file (when `lintFile` is wired)
 * — the STRICTNESS MOAT (`no-as`, `I`-prefix, `prefer-template`) that tsc is blind
 * to. A run log showed `Object.keys(x) as unknown as …` written in every domain
 * file: type-valid, so the old type-only guard passed it, and the `as` violations
 * piled up unseen until the gate. Together they convert the dominant failure mode
 * (write 8 files → discover a 40-issue cascade at the gate → many repair turns)
 * into (write 1 file → see its issue now → fix it). Transient "cannot find module"
 * for not-yet-created siblings is filtered as expected noise.
 */
async function writeGuard(
  ctx: { tsService: TsService; cwd: string; lintFile?: FileLinter },
  file: string,
  report: Reporter,
  taskId: string
): Promise<string> {
  const { tsService, cwd, lintFile } = ctx;
  // `file` is workspace-relative (the create/edit handler normalized it); the
  // strip/linter/readFileSync need the absolute path.
  const absPath = join(cwd, file);
  // Strip the model's reflexive needless literal-to-union casts NOW (deterministic,
  // safe) so it's never told about them and never spends a turn removing them.
  const stripped = await stripLiteralCasts(absPath).catch(() => 0);

  if (stripped > 0) {
    report({
      kind: "tool",
      task: taskId,
      message: `stripped ${String(stripped)} needless literal cast(s) in ${basename(absPath)}`,
    });
  }

  tsService.refresh(file);

  const typeErrors = tsService
    .diagnostics(file)
    .filter((d) => !TRANSIENT_DIAG_CODES.has(d.code));
  const lintProblems = lintFile === undefined ? [] : await lintFile(absPath);
  // BLAST RADIUS: files that depend on this one and now have errors. Computed even
  // when THIS file is clean — a signature change can compile here but break callers.
  const dependants = tsService.dependantErrors(file, TRANSIENT_DIAG_CODES);
  const total = typeErrors.length + lintProblems.length;

  if (total === 0 && dependants.length === 0) {
    return "";
  }

  // Emit a visible event so the write-guard is observable in the log + countable
  // by cli-metrics (the corrective feedback itself rides the tool result message).
  report({
    kind: "tool",
    task: taskId,
    message: `⚠ write-check: ${String(typeErrors.length)} type + ${String(lintProblems.length)} lint issue(s)${dependants.length > 0 ? `, ${String(dependants.length)} dependant file(s) broken` : ""} in ${basename(absPath)} — fed back to fix inline`,
  });

  if (total === 0) {
    return dependantBlastRadius(dependants);
  }

  return (
    `\n\n⚠ CHECK of this file found ${String(total)} issue(s) — fix them now ` +
    "(edit this file) before writing others; ignore any 'cannot find module' for " +
    `files you'll create next:\n${writeGuardLines(absPath, typeErrors, lintProblems)}` +
    dependantBlastRadius(dependants)
  );
}

/**
 * Invoke the write-guard for a just-written file — best-effort: a guard failure
 * must NEVER break the build (the gate stays the authority), so a null service or
 * any thrown error degrades to no feedback. Extracted so `runToolCalls` stays
 * under the cognitive-complexity bar.
 */
async function runWriteGuard(ctx: ILoopCtx, path: string): Promise<string> {
  if (ctx.tsService === null || path.length === 0) {
    return "";
  }

  try {
    return await writeGuard(
      {
        tsService: ctx.tsService,
        cwd: ctx.cwd,
        ...(ctx.lintFile === undefined ? {} : { lintFile: ctx.lintFile }),
      },
      path,
      ctx.report,
      ctx.task.id
    );
  } catch {
    return "";
  }
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

    // Count an edit/create ONLY when it actually wrote an in-scope file. We read
    // this from the handler's `edit`/`create` event — which carries the path it
    // ACTUALLY wrote, already normalized (absolute / repeated-root / backslash
    // paths resolved). Scope-checking the raw tool arg here instead would miss a
    // write the handler normalized into scope, skipping the gate. The event fires
    // only on a successful write, so failures/rejects never count. See P1/P2.
    // (Object ref, not a captured `let`: CFA de-narrows a property after a call.)
    const wrote = { value: false, path: "" };

    const report: Reporter = (event) => {
      if (
        (event.kind === "edit" || event.kind === "create") &&
        event.file !== undefined &&
        isInScope(event.file, ctx.task.files)
      ) {
        wrote.value = true;
        wrote.path = event.file;
      }

      ctx.report(event);
    };

    const result = await executeTool(call, {
      cwd: ctx.cwd,
      files: ctx.task.files,
      report,
      task: ctx.task.id,
      tsService: ctx.tsService,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });

    let feedback = "";

    if (wrote.value) {
      touchedEditable = true;
      state.edits += 1;
      feedback = await runWriteGuard(ctx, wrote.path);
    }

    // A semantic write (rename/organize_imports) is scope-enforced internally and
    // mutates on success — re-gate to confirm. (These don't feed state.edits.)
    if (
      call.name === TOOL_NAME.renameSymbol ||
      call.name === TOOL_NAME.organizeImports
    ) {
      touchedEditable = true;
    }

    ctx.messages.push({
      role: "tool",
      content: `${result}${feedback}`,
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
  // Resolve globs to concrete files — iterating task.files literally would skip a
  // glob scope like `["**/*"]` (the common interactive default), so the fixes
  // never ran there. See P1 review.
  const files = await resolveScopeFiles(cwd, task.files);

  if (tsService !== null) {
    let tsFixed = 0;

    for (const f of files) {
      try {
        if (await fileExists(cwd, f)) {
          tsService.refresh(f);
          tsFixed += tsService.fixAll(f);
          // Dedupe/sort imports + drop unused ones the model left behind — free
          // mechanical cleanup so it never spends a repair turn on import hygiene.
          tsFixed += tsService.organizeImports(f);
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

  for (const f of files) {
    try {
      if (await fileExists(cwd, f)) {
        astFixed += await astGrepFix(join(cwd, f));
        // Backstop the write-time strip (covers files changed via rename/organize
        // or any path that skipped the write-guard).
        astFixed += await stripLiteralCasts(join(cwd, f));
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

  // Resolve globs so a glob scope is polished too (not silently skipped).
  const files = await resolveScopeFiles(cwd, task.files);
  const snapshot = new Map<string, string>();

  for (const f of files) {
    if (await fileExists(cwd, f)) {
      snapshot.set(f, await Bun.file(join(cwd, f)).text());
    }
  }

  let dropped = 0;

  for (const f of files) {
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

/** Snapshot the editable files' mtimes (ms) — cheap stat, used to detect which
 *  files the deterministic fixers + fix command rewrote. */
async function snapshotMtimes(
  cwd: string,
  files: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();

  for (const f of await resolveScopeFiles(cwd, files)) {
    try {
      out.set(f, Bun.file(join(cwd, f)).lastModified);
    } catch {
      // ignore — a file that can't be stat'd just isn't tracked
    }
  }

  return out;
}

/** Files whose mtime advanced between two snapshots — i.e. a fixer rewrote them. */
function changedSince(
  before: Map<string, number>,
  after: Map<string, number>
): string[] {
  const changed: string[] = [];

  for (const [f, mtime] of after) {
    const prev = before.get(f);

    if (prev === undefined || mtime > prev) {
      changed.push(f);
    }
  }

  return changed;
}

/** Max auto-fixed files to name in the notice before eliding. */
const MAX_AUTOFIX_NAMED = 20;

/** Tell the model what the janitor just changed, so it re-reads before editing and
 *  doesn't waste turns re-fixing formatting/imports (or edit stale text → reject). */
function autoFixNotice(files: string[]): string {
  const shown = files.slice(0, MAX_AUTOFIX_NAMED).join(", ");
  const more =
    files.length > MAX_AUTOFIX_NAMED
      ? ` (+${String(files.length - MAX_AUTOFIX_NAMED)} more)`
      : "";

  return (
    `NOTE: automatic fixers (prettier, eslint --fix, organize-imports, TS quick-fixes) ` +
    `just reformatted/fixed and SAVED these files: ${shown}${more}. Those style/import/` +
    `formatting fixes are DONE — do not redo them. Their on-disk text now DIFFERS from ` +
    `what you wrote, so \`read\` a file before editing it. Fix ONLY the errors below.`
  );
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
  // Snapshot before the fixers so we can tell the model exactly what they changed
  // (else it re-fixes already-fixed style and edits now-stale text → rejects).
  const beforeFix = await snapshotMtimes(cwd, task.files);

  await applyDeterministicFixes(ctx);

  if (task.fix !== undefined && task.fix.length > 0) {
    await runAccept(
      { ...task, accept: task.fix },
      cwd,
      ctx.signal === undefined ? {} : { signal: ctx.signal }
    );
  }

  const autoFixed = changedSince(
    beforeFix,
    await snapshotMtimes(cwd, task.files)
  );

  if (autoFixed.length > 0) {
    report({
      kind: "tool",
      task: task.id,
      message: `auto-fixed ${String(autoFixed.length)} file(s) (prettier/eslint/imports) — noted to the model`,
    });
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

  const feedback = await gateFeedback(gate.errors, task, cwd);
  const notice = autoFixed.length > 0 ? `${autoFixNotice(autoFixed)}\n\n` : "";

  messages.push({ role: "user", content: `${notice}${feedback}` });

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
