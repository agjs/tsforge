import { basename, join, relative, isAbsolute } from "node:path";
import type { ITask } from "../spec";
import type { IChatMessage, IToolCall } from "../inference";
import {
  validate,
  runAccept,
  sameErrorSet,
  type ErrorParser,
  type ErrorSet,
  type IErrorItem,
} from "../validate";
import { isInScope } from "../lib/scope";
import type { PolicyMode, IPolicyRules } from "../policy";
import { fileExists, resolveScopeFiles } from "../lib/fs";
import { RUN_STATUS, STUCK_REASON, LOOP_LIMITS } from "./loop.constants";
import type { IRunResult, Reporter } from "./loop.types";
import { flags } from "../config";
import type { IStackProfile } from "../stack-detection";
import { gateFeedback } from "./feedback";
import { executeTool, type SetupWebFn, type IToolContext } from "./tools";
import {
  astGrepFix,
  dropRedundantAnnotations,
  stripLiteralCasts,
} from "./astgrep-fix";
import {
  EDIT_TOOL,
  EDIT_LINES_TOOL,
  CREATE_TOOL,
  RUN_TOOL,
  READ_TOOL,
  LSP_TOOLS,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WEB_BROWSE_TOOL,
  PACKAGE_INFO_TOOL,
  PACKAGE_DOCS_TOOL,
  SCRIPT_TOOL,
  GIT_CONTEXT_TOOL,
} from "../agent";
import { TsService } from "../lsp";
import type { McpRegistry } from "../mcp";
import type { FileLinter } from "../detect-gate";
import {
  buildMetaRuleContext,
  runMetaRules,
  META_RULES,
  type IMetaRuleViolation,
} from "../meta-rules";
import { runWriteGuard } from "./write-guard";

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

const HASHLINE_TOOLS = flags.hashlineEditTool() ? [EDIT_LINES_TOOL] : [];

// The full advertisable set: base + hashline + LSP nav + the (gated) web tools.
// Its element union is also the return TYPE of toolsFor — every narrower runtime
// list below is assignable to it, so each tool stays independently gated.
/** Every tool the harness can advertise — the element union all the narrower
 *  per-context lists below are assignable to (each tool stays independently gated
 *  in toolsFor). */
type AdvertisedTool =
  | (typeof BASE_TOOLS)[number]
  | (typeof HASHLINE_TOOLS)[number]
  | (typeof LSP_TOOLS)[number]
  | typeof WEB_FETCH_TOOL
  | typeof WEB_SEARCH_TOOL
  | typeof WEB_BROWSE_TOOL
  | typeof PACKAGE_INFO_TOOL
  | typeof PACKAGE_DOCS_TOOL
  | typeof SCRIPT_TOOL
  | typeof GIT_CONTEXT_TOOL;

/** Free, local web tools (fetch + search) — advertised only under TSFORGE_WEB so
 *  eval sweeps stay deterministic and offline by default. Available on both
 *  scratch and existing-code runs when enabled (unlike the LSP nav set). */
function webTools(): AdvertisedTool[] {
  return flags.webTools()
    ? [
        WEB_FETCH_TOOL,
        WEB_SEARCH_TOOL,
        WEB_BROWSE_TOOL,
        PACKAGE_INFO_TOOL,
        PACKAGE_DOCS_TOOL,
      ]
    : [];
}

/** Read-only git introspection — existing-code runs only (greenfield has no
 *  history), withheld under TSFORGE_NO_GIT_TOOL. Not an LSP tool (no tsconfig
 *  needed), so it survives TSFORGE_NO_LSP_TOOLS — it's gated only on history. */
function gitTools(hasExistingCode: boolean): AdvertisedTool[] {
  return hasExistingCode && !flags.noGitTool() ? [GIT_CONTEXT_TOOL] : [];
}

/** Programmatic Tool Calling — ON by default (withheld under TSFORGE_NO_SCRIPT).
 *  Available on both scratch and existing-code runs; the plan-mode path rejects it
 *  at dispatch (it's a mutating tool), so a script can't write while planning. */
function scriptTools(): AdvertisedTool[] {
  return flags.scriptTool() ? [SCRIPT_TOOL] : [];
}

export function toolsFor(hasExistingCode: boolean): AdvertisedTool[] {
  const web = webTools();
  const git = gitTools(hasExistingCode);
  const script = scriptTools();

  if (flags.noLspTools() || !hasExistingCode) {
    return [...BASE_TOOLS, ...HASHLINE_TOOLS, ...web, ...git, ...script];
  }

  // existing-code: base + LSP nav + (gated) web + (gated) git + (gated) script.
  return [
    ...BASE_TOOLS,
    ...HASHLINE_TOOLS,
    ...LSP_TOOLS,
    ...web,
    ...git,
    ...script,
  ];
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
  /** Detected stack profile — determines which rule packs are enabled. */
  stackProfile?: IStackProfile;
  /** Files the agent created/edited this session (cwd-relative, forward slashes).
   *  Accumulated by `runToolCalls`; change-scoped meta-rules (test-sibling-required)
   *  enforce on this set, so they cover what the agent wrote regardless of git. */
  touched?: Set<string>;
  /** Rule severity overrides from tsforge.config.json (maps rule ID to "error" | "warn" | "off"). */
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>;
  /** When set, the gate's command output is streamed here live (the CLI wires
   *  this so a slow gate like `vite build` + browser isn't silent dead air).
   *  Omitted on the eval path, where output is just captured for scoring.
   *  `flush()` (when present) is called once the gate exits to emit any final
   *  line the process printed without a trailing newline. */
  onGateChunk?: ((text: string) => void) & { flush?: () => void };
  /** Cancellation for the in-flight turn — threaded into tool `run` commands and
   *  the gate so a Ctrl-C (or a kill-timeout) reaches the child processes, not
   *  just the model call. Set per-send by the Session. */
  signal?: AbortSignal;
  /** Wired by the interactive CLI: turn this workspace into a web project (the
   *  `scaffold_web` tool calls it). Threaded into the tool context. */
  setupWeb?: SetupWebFn;
  /** PLAN MODE (set via Session.setPlanMode): threaded into the tool context so
   *  mutating tools are rejected at dispatch — the model only plans. */
  readOnly?: boolean;
  /** Active policy mode for the unified action-policy layer (executeTool). Plan
   *  mode forces `"plan"`; otherwise the base mode from CLI/config (default
   *  `"default"`). Threaded into the tool context. */
  policyMode?: PolicyMode;
  /** Config-driven policy rules (deny/allow/ask) threaded to the tool context. */
  policyRules?: IPolicyRules;
  /** Whether an interactive per-action approval path exists (false today). */
  interactive?: boolean;
  /** Connected MCP servers (opt-in via tsforge.config.json `mcpServers`). Threaded
   *  into the tool context so `mcp__<server>__<tool>` calls dispatch to them. */
  mcpRegistry?: McpRegistry;
}

/** Mutable state threaded across turns (the gradient the loop descends). */
export interface ILoopState {
  prevGateErrors: ErrorSet;
  gateNoProgress: number;
  /** Fewest gate errors seen so far (the convergence watermark) + how many cycles
   *  since it last hit a NEW low. Drives the net-progress stop: a churning build
   *  whose error SET keeps shuffling (so `gateNoProgress` resets) and whose errors
   *  never survive `samePersist` consecutive cycles evades both other guards — but
   *  if the count isn't trending DOWN it isn't converging, regardless of turn count. */
  bestErrorCount: number;
  noNewLow: number;
  /** Per-error-key (file:rule) survival count: how many consecutive gate cycles
   *  each error has persisted. Drives the primary `samePersist` no-progress stop. */
  errorAge: Map<string, number>;
  lastGateCount: number;
  edits: number;
  regressions: number;
  /** Count of TTSR rule interrupts this task. Hard cap at 3 to prevent loops. */
  ttsrInterrupts: number;
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

export { isPhantomRouteError } from "./write-guard";

/** Whether a `mutated` path counts toward re-gating + the change scope. Mutating
 *  handlers self-enforce scope before they write, so this is mostly a backstop —
 *  EXCEPT package.json: `add_dependency` is sanctioned to rewrite the manifest even
 *  when it sits outside the task's editable globs, and that change MUST re-gate so
 *  the supply-chain meta-rules run (unpinned / git / tarball deps). A narrow-scoped
 *  task would otherwise let a `bun add` bypass the gate entirely. */
export function countsAsMutation(file: string, taskFiles: string[]): boolean {
  return basename(file) === "package.json" || isInScope(file, taskFiles);
}

/** Add paths (cwd-relative, forward-slashed) to the session's change set — the
 *  scope change-scoped gate rules (test-sibling-required) enforce on. Lazy-inits
 *  `touched` so a custom loop runner that forgot to seed it self-heals rather than
 *  silently dropping enforcement. */
function recordTouched(ctx: ILoopCtx, files: readonly string[]): void {
  ctx.touched ??= new Set<string>();

  for (const f of files) {
    const rel = isAbsolute(f) ? relative(ctx.cwd, f) : f;

    ctx.touched.add(rel.replaceAll("\\", "/"));
  }
}

/** Build the per-call tool context from the loop context. Extracted so the
 *  optional-field spreads don't inflate `runToolCalls`'s cognitive complexity. */
function toolContextFor(ctx: ILoopCtx, report: Reporter): IToolContext {
  return {
    cwd: ctx.cwd,
    files: ctx.task.files,
    report,
    task: ctx.task.id,
    tsService: ctx.tsService,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    ...(ctx.setupWeb === undefined ? {} : { setupWeb: ctx.setupWeb }),
    ...(ctx.readOnly === undefined ? {} : { readOnly: ctx.readOnly }),
    ...(ctx.policyMode === undefined ? {} : { policyMode: ctx.policyMode }),
    ...(ctx.policyRules === undefined ? {} : { policyRules: ctx.policyRules }),
    ...(ctx.interactive === undefined ? {} : { interactive: ctx.interactive }),
    ...(ctx.mcpRegistry === undefined ? {} : { mcpRegistry: ctx.mcpRegistry }),
    // Share the session change-set BY REFERENCE so `create` can see which files the
    // model authored in PRIOR turns (recordTouched mutates this same Set post-write).
    ...(ctx.touched === undefined ? {} : { touched: ctx.touched }),
  };
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
    // EVERY in-scope file written during this tool call — a Set, not a single
    // path, because ONE call can write MANY files: the `script` tool runs a
    // program whose edit/create stubs each report a write through this same
    // callback. Tracking only the last path would skip the write-guard + touched
    // (and thus change-scoped rules like test-sibling-required) for the rest.
    const wrote = new Set<string>();
    // Files mutated by a tool the model did NOT hand-write (semantic ops,
    // scaffolds). These re-gate and join the change scope but skip the write-guard.
    const mutated: string[] = [];

    const report: Reporter = (event) => {
      if (
        (event.kind === "edit" || event.kind === "create") &&
        event.file !== undefined &&
        isInScope(event.file, ctx.task.files)
      ) {
        wrote.add(event.file);
      }

      if (event.mutated !== undefined) {
        for (const f of event.mutated) {
          if (countsAsMutation(f, ctx.task.files)) {
            mutated.push(f);
          }
        }
      }

      ctx.report(event);
    };

    const result = await executeTool(call, toolContextFor(ctx, report));

    let feedback = "";

    if (wrote.size > 0) {
      touchedEditable = true;
      state.edits += wrote.size;
      const written = [...wrote];

      // Record EVERY file written so change-scoped gate rules (test-sibling-
      // required) enforce on all of them, then write-guard each.
      recordTouched(ctx, written);

      for (const path of written) {
        feedback += await runWriteGuard(ctx, path);
      }
    }

    // A tool that mutated files without the model hand-writing them (a successful
    // semantic op or scaffold) must re-gate so the change is verified — the signal
    // comes from the handler's `mutated` event, emitted ONLY on a real change.
    // Keying off the tool NAME (the old approach) miscounted a rejected/no-op op
    // as a mutation, letting a green gate claim "done" though nothing happened, and
    // missed scaffolds entirely, letting them skip the gate. These paths join the
    // change scope but are NOT write-guarded — generated shells aren't re-checked.
    if (mutated.length > 0) {
      touchedEditable = true;
      recordTouched(ctx, mutated);
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
 * Net-progress guard step: track the fewest gate errors ever seen (the convergence
 * watermark). A new low = real progress → reset the counter; otherwise count a
 * cycle of no improvement. Returns true once the count hasn't beaten its best in
 * `noProgressCycles` cycles — the model is churning without converging (errors
 * shuffle so the whole-set guard resets, and no single error survives `samePersist`,
 * yet it never gets closer to green). Convergence — not a turn count — bounds a run,
 * so a large app may take any number of turns as long as the error count trends down.
 */
export function trackNetProgress(
  state: ILoopState,
  errorCount: number
): boolean {
  if (errorCount < state.bestErrorCount) {
    state.bestErrorCount = errorCount;
    state.noNewLow = 0;
  } else {
    state.noNewLow += 1;
  }

  return state.noNewLow >= LOOP_LIMITS.noProgressCycles;
}

/**
 * Advance each error's per-(file:rule) survival count and return the first error
 * that has now persisted for `samePersist` consecutive gate cycles — the model
 * keeps failing at the SAME thing — or null. Rebuilds the map from the CURRENT
 * keys, so a fixed error's age drops out (no stale growth) and an error that
 * comes back later starts fresh. Catches "stuck on X" even while OTHER errors
 * churn around it (which the whole-set `gateNoProgress` guard misses).
 */
export function trackErrorAges(
  state: ILoopState,
  gateErrors: ErrorSet
): IErrorItem | null {
  const next = new Map<string, number>();
  let stuck: IErrorItem | null = null;

  for (const e of gateErrors) {
    const age = (state.errorAge.get(e.key) ?? 0) + 1;

    next.set(e.key, age);

    if (age >= LOOP_LIMITS.samePersist && stuck === null) {
      stuck = e;
    }
  }

  state.errorAge = next;

  return stuck;
}

/** The blocker diagnosis surfaced when a single error persists too long — names
 *  the rule + file + attempt count + the last message, so an interactive session
 *  hands back something the user can act on. */
export function persistDetail(e: IErrorItem): string {
  const where = e.file !== undefined ? ` in ${e.file}` : "";
  const rule = e.rule ?? "the same error";

  return `stuck on ${rule}${where} after ${String(LOOP_LIMITS.samePersist)} attempts (last: ${e.message.slice(0, 140)})`;
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

  // The gate process has exited — flush any final newline-less line the stream
  // filter is still holding so it reaches the terminal.
  ctx.onGateChunk?.flush?.();

  // Run meta-rules against the project — project structure invariants the gate
  // can't express. Convert error-severity violations to gate failures; warn
  // violations are surfaced in feedback but don't block. Apply config overrides
  // from ctx.ruleOverrides (already loaded and normalized in run.ts).
  let metaViolations: IMetaRuleViolation[] = [];

  try {
    // The files the AGENT created/edited this session — what change-scoped rules
    // (test-sibling-required) enforce on. This is the real signal, not git: it
    // works in any directory (including a freshly generated, non-git project) and
    // never blocks on the repo's pre-existing untested code.
    const changed = [...(ctx.touched ?? [])];
    const metaContext = buildMetaRuleContext(
      cwd,
      ctx.stackProfile?.packs ?? [],
      changed
    );

    metaViolations = runMetaRules(META_RULES, metaContext, ctx.ruleOverrides);
  } catch {
    // Degrade silently — meta-rules are supplementary to the gate
  }

  const metaErrors = metaViolations.filter((v) => v.severity === "error");
  const gateErrors = gate.errors.concat(
    metaErrors.map((v) => ({
      key: `${v.file}:${v.ruleId}`,
      file: v.file,
      rule: v.ruleId,
      message: v.message,
    }))
  );

  if (state.lastGateCount >= 0 && gateErrors.length > state.lastGateCount) {
    state.regressions += 1;
  }

  state.lastGateCount = gateErrors.length;

  // Determine pass/fail: the gate passes only if BOTH gate command AND meta-rules are clean
  const gatePassed = gate.passed && metaErrors.length === 0;

  // On red, surface the ACTUAL errors (codes + messages) into the event — so the
  // log records WHAT failed at the gate, not just a count (the analysis substrate
  // for finding systematic mistakes to fix in the harness).
  const gateDetail = gatePassed
    ? ""
    : `:\n${gateErrors
        .slice(0, 20)
        .map((e) => `  ${e.message}`)
        .join("\n")}`;

  report({
    kind: "validated",
    task: task.id,
    cycle: turn,
    passed: gatePassed,
    errors: gateErrors.length,
    // Structured rule/code list (not just a count) so the failure classifier can
    // tell a type error from a lint rule without re-parsing the gate output.
    rules: gateErrors.flatMap((e) => (e.rule === undefined ? [] : [e.rule])),
    message: gatePassed
      ? `task ${task.id} · turn ${turn}: GREEN`
      : `task ${task.id} · turn ${turn}: red (${String(gateErrors.length)} error(s))${gateDetail}`,
  });

  if (gatePassed) {
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

  // PRIMARY no-progress stop: the model keeps failing at the SAME (file,rule)
  // for `samePersist` cycles running — even if other errors churn. Hand back a
  // concrete blocker rather than spinning to a raw turn cap.
  const persisted = trackErrorAges(state, gateErrors);

  if (persisted !== null) {
    const detail = persistDetail(persisted);

    report({
      kind: "stuck",
      task: task.id,
      cycles: turn,
      detail,
      message: `task ${task.id}: ${detail}`,
    });

    return {
      task: task.id,
      redConfirmed: true,
      status: RUN_STATUS.stuck,
      cycles: turn,
      reason: STUCK_REASON.stalled,
      detail,
    };
  }

  // Coarser secondary net: the WHOLE error set unchanged this many cycles.
  state.gateNoProgress = sameErrorSet(state.prevGateErrors, gateErrors)
    ? state.gateNoProgress + 1
    : 0;
  state.prevGateErrors = gateErrors;

  if (state.gateNoProgress >= LOOP_LIMITS.gateStuckRepeats) {
    const detail = `gate unchanged ${String(LOOP_LIMITS.gateStuckRepeats)} cycles (${String(gateErrors.length)} error(s) not converging)`;

    report({
      kind: "stuck",
      task: task.id,
      cycles: turn,
      detail,
      message: `task ${task.id}: stuck — ${detail}`,
    });

    return {
      task: task.id,
      redConfirmed: true,
      status: RUN_STATUS.stuck,
      cycles: turn,
      reason: STUCK_REASON.stalled,
      detail,
    };
  }

  // NET-PROGRESS stop (the convergence guard, not a turn count): big apps run as
  // long as the error count keeps dropping; we stop when it churns without getting
  // closer to green — the through-12 failure mode that evaded both guards above.
  if (trackNetProgress(state, gateErrors.length)) {
    const detail = `no net progress: ${String(gateErrors.length)} error(s) open, none cleared in ${String(LOOP_LIMITS.noProgressCycles)} cycles (best ${String(state.bestErrorCount)}) — not converging`;

    report({
      kind: "stuck",
      task: task.id,
      cycles: turn,
      detail,
      message: `task ${task.id}: stuck — ${detail}`,
    });

    return {
      task: task.id,
      redConfirmed: true,
      status: RUN_STATUS.stuck,
      cycles: turn,
      reason: STUCK_REASON.stalled,
      detail,
    };
  }

  const feedback = await gateFeedback(gateErrors, task, cwd, metaViolations);
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
