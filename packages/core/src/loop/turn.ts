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
import { TOOL_NAME } from "../agent/agent.constants";
import { isInScope } from "../lib/scope";
import { trace } from "../lib/trace";
import type { PolicyMode, IPolicyRules } from "../policy";
import { fileExists, resolveScopeFiles } from "../lib/fs";
import { RUN_STATUS, STUCK_REASON, LOOP_LIMITS } from "./loop.constants";
import type { IRunResult, Reporter } from "./loop.types";
import { flags } from "../config";
import type { IStackProfile } from "../stack-detection";
import { gateFeedback } from "./feedback";
import { unseenGuidesForErrors } from "./conventions";
import {
  buildSteerMessage,
  essentialMessages,
  STEER_LADDER_MAX,
} from "./feedback/steer";
import {
  runExpertHandoff,
  resolveExpertAsk,
  resolveStuckFile,
  type ExpertAsk,
} from "./expert-handoff";
import { executeTool, type SpawnAgentFn, type IToolContext } from "./tools";
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
  PULL_CONVENTIONS_TOOL,
  SCRIPT_TOOL,
  GIT_CONTEXT_TOOL,
  READ_IMAGE_TOOL,
  GENERATE_IMAGE_TOOL,
} from "../agent";
import { TsService } from "../lsp";
import type { McpRegistry } from "../mcp";
import type { FileLinter } from "../gate";
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

const HASHLINE_TOOLS = [EDIT_LINES_TOOL];

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
  | typeof PULL_CONVENTIONS_TOOL
  | typeof SCRIPT_TOOL
  | typeof GIT_CONTEXT_TOOL
  | typeof READ_IMAGE_TOOL
  | typeof GENERATE_IMAGE_TOOL;

/** Which extra capability backends are configured this run — decides whether the
 *  image tools are advertised. Resolved once by the driver (run.ts) so
 *  advertisement stays synchronous here. Both default off. */
export interface ICapabilityFlags {
  vision?: boolean;
  imageGen?: boolean;
}

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

/** Image capability tools — each advertised only when its backend is configured
 *  (caps resolved by the driver). read_image (vision) and generate_image are
 *  independent, so a vision-only or gen-only setup offers just the one. */
function imageTools(caps: ICapabilityFlags): AdvertisedTool[] {
  return [
    ...(caps.vision === true ? [READ_IMAGE_TOOL] : []),
    ...(caps.imageGen === true ? [GENERATE_IMAGE_TOOL] : []),
  ];
}

export function toolsFor(
  hasExistingCode: boolean,
  caps: ICapabilityFlags = {},
  offerConventions = false
): AdvertisedTool[] {
  const web = webTools();
  const git = gitTools(hasExistingCode);
  const script = scriptTools();
  const image = imageTools(caps);

  // pull_conventions — a read-only knowledge tool the model calls to fetch the
  // BoringStack how-to BEFORE writing that kind of code (the PULL complement to the
  // harness PUSHing guides on first violation). Offered per BUILD BACKEND, not per
  // flag: a backend with a convention library (boringstack) opts in via the session
  // config; a plain scratch/logic task leaves it off so the base tool set stays
  // minimal (tools-gating). Decoupled from the web flag on purpose — the conventions
  // are the stack's, not "web".
  const conventions: AdvertisedTool[] = offerConventions
    ? [PULL_CONVENTIONS_TOOL]
    : [];

  if (flags.noLspTools() || !hasExistingCode) {
    return [
      ...BASE_TOOLS,
      ...HASHLINE_TOOLS,
      ...conventions,
      ...web,
      ...git,
      ...script,
      ...image,
    ];
  }

  // existing-code: base + LSP nav + (gated) web + (gated) git + (gated) script.
  return [
    ...BASE_TOOLS,
    ...HASHLINE_TOOLS,
    ...conventions,
    ...LSP_TOOLS,
    ...web,
    ...git,
    ...script,
    ...image,
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

/** Tool-EXECUTION options — the fields `toolContextFor` threads into every
 *  IToolContext (grouped so the spread is `...ctx.tool`, not eight conditional
 *  spreads). Always-present and mutable: the Session flips these mid-run
 *  (plan mode, per-send signal, setupWeb wiring). */
export interface ILoopCtxTool {
  /** Cancellation for the in-flight turn — threaded into tool `run` commands and
   *  the gate so a Ctrl-C (or a kill-timeout) reaches the child processes, not
   *  just the model call. Set per-send by the Session. */
  signal?: AbortSignal;
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
  /** Files the agent created/edited this session (cwd-relative, forward slashes).
   *  Accumulated by `runToolCalls`; change-scoped meta-rules (test-sibling-required)
   *  enforce on this set, so they cover what the agent wrote regardless of git.
   *  Shared BY REFERENCE with the tool context. */
  touched?: Set<string>;
  /** Wired by the interactive CLI: run one read-only specialist subagent (the
   *  `spawn_agent` tool). Threaded into the tool context. */
  spawnAgent?: SpawnAgentFn;
  /** Wired by the interactive CLI: preview a just-generated image inline (the
   *  `generate_image` tool calls it). Threaded into the tool context. */
  previewImage?: IToolContext["previewImage"];
}

/** Gate/VALIDATION options — what `settleGate` and the write-guard consume. */
export interface ILoopCtxGate {
  parse: ErrorParser | undefined;
  /** Write-time single-file linter (the gate's eslint rules, applied per write so
   *  moat violations tsc can't see surface inline). Omitted ⇒ type-only guard. */
  lintFile?: FileLinter;
  /** Detected stack profile — determines which rule packs are enabled. */
  stackProfile?: IStackProfile;
  /** Rule severity overrides from tsforge.config.json (maps rule ID to "error" | "warn" | "off"). */
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>;
  /** When set, the gate's command output is streamed here live (the CLI wires
   *  this so a slow gate like `vite build` + browser isn't silent dead air).
   *  Omitted on the eval path, where output is just captured for scoring.
   *  `flush()` (when present) is called once the gate exits to emit any final
   *  line the process printed without a trailing newline. */
  onGateChunk?: ((text: string) => void) & { flush?: () => void };
}

/** The coordinator's per-task working context: the flat identity/reporting core,
 *  plus the tool-execution (`tool`) and gate/validation (`gate`) option groups. */
export interface ILoopCtx {
  task: ITask;
  cwd: string;
  tsService: TsService | null;
  report: Reporter;
  messages: IChatMessage[];
  tool: ILoopCtxTool;
  gate: ILoopCtxGate;
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
  /** Steering ladder: how many times a convergence guard has tripped and escalated
   *  a steer this run (0 = never stalled). Each escalation resets the guards so the
   *  model gets fresh cycles at a more directive steer; a run only parks once this
   *  exceeds the ladder (see checkStuck). */
  steerLevel: number;
  /** The steer message to inject on the NEXT feedback push (set when a guard trips,
   *  cleared once injected). Undefined when no steer is pending. */
  pendingSteer?: string;
  /** How many times the EXPERT handoff (the rung above the ladder) has fired this
   *  run. Capped so a strong-model rescue is a few-shot escape, not a loop. */
  expertUses?: number;
  /** Set at the top steer rung: the NEXT feedback push first PRUNES the flailing
   *  conversation to its essentials (system + original task), so the model's new
   *  strategy isn't anchored to the dead-end transcript. Cleared once applied. */
  resetContext?: boolean;
  /** Convention topics already PUSHED this run (dedupe): the boringstack how-to for
   *  a rule is attached the FIRST time it's tripped, once per topic — see
   *  `unseenGuidesForErrors`. */
  pushedGuides?: Set<string>;
  /** The backend ships a convention library, so the loop may PUSH its how-to guides
   *  beside gate errors. Set from `ISessionConfig.pullConventions` — the SAME signal
   *  that offers the `pull_conventions` tool, so push + pull activate together. A
   *  plain build (no convention backend) leaves it off and gets neither. */
  conventionsEnabled?: boolean;
  /** PLATEAU backstop (oscillation detector): consecutive gate cycles since the error
   *  count last hit a new ALL-TIME low. Unlike the fine guards it does NOT reset on an
   *  error-set rotation or a non-improving re-visit — only genuine progress (a new low)
   *  clears it — so an oscillating model can't hide from it. See `LOOP_LIMITS.plateauGates`. */
  redGates?: number;
  /** Lowest gate-error count seen this run, NEVER reset on escalation (unlike
   *  `bestErrorCount`) — the stable baseline the plateau backstop measures against. */
  plateauBest?: number;
}

/** Build the in-process TS LanguageService if the project has a tsconfig. Guarded
 *  so a setup failure can't break the loop (the `tsc -p` gate stays authority). */
export async function buildTsService(cwd: string): Promise<TsService | null> {
  try {
    if (await fileExists(cwd, "tsconfig.json")) {
      return new TsService(cwd);
    }
  } catch (err) {
    // degrade silently — the gate runs regardless
    trace("buildTsService", err);
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
  const touched = (ctx.tool.touched ??= new Set<string>());

  for (const f of files) {
    const rel = isAbsolute(f) ? relative(ctx.cwd, f) : f;

    touched.add(rel.replaceAll("\\", "/"));
  }
}

/** Build the per-call tool context from the loop context. `ctx.tool` groups
 *  exactly the optional fields IToolContext threads through, so ONE spread
 *  replaces the old eight per-field conditional spreads. `touched` rides the
 *  spread BY REFERENCE, so `create` sees files the model authored in PRIOR turns
 *  (recordTouched mutates this same Set post-write). */
function toolContextFor(ctx: ILoopCtx, report: Reporter): IToolContext {
  return {
    cwd: ctx.cwd,
    files: ctx.task.files,
    report,
    task: ctx.task.id,
    tsService: ctx.tsService,
    ...ctx.tool,
  };
}

/** Stable per-call key, matching the `toolCallId` the loop emits below. */
function callKey(call: IToolCall, index: number): string {
  return call.id ?? `call_${index}`;
}

/** One position in the tool-call list, kept with its original index so the tool
 *  reply carries the right `toolCallId` even after we group spawns. */
interface IIndexedCall {
  readonly call: IToolCall;
  readonly index: number;
}

/**
 * Run ONE non-spawn tool call: execute it, apply the write-guard + mutation
 * accounting, and push its tool reply. Returns whether it touched an editable
 * file (⇒ the caller re-gates). `state.edits` is bumped per in-scope write.
 */
async function runOneToolCall(
  call: IToolCall,
  index: number,
  ctx: ILoopCtx,
  state: ILoopState
): Promise<boolean> {
  let touchedEditable = false;
  // EVERY in-scope file written during this tool call — a Set, not a single
  // path, because ONE call can write MANY files (a `script` program's edit/create
  // stubs each report through this callback). We read the path from the handler's
  // `edit`/`create` event (already normalized), not the raw arg, so a write the
  // handler normalized into scope still counts. Fires only on a successful write.
  const wrote = new Set<string>();
  // Files mutated by a tool the model did NOT hand-write (semantic ops, scaffolds):
  // they re-gate and join the change scope but skip the per-write guard.
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

    recordTouched(ctx, written);

    for (const path of written) {
      feedback += await runWriteGuard(ctx, path);
    }
  }

  if (mutated.length > 0) {
    touchedEditable = true;
    recordTouched(ctx, mutated);
  }

  ctx.messages.push({
    role: "tool",
    content: `${result}${feedback}`,
    toolCallId: callKey(call, index),
  });

  return touchedEditable;
}

/**
 * Run a CONSECUTIVE run of read-only `spawn_agent` calls concurrently — they
 * never write, so ordering among them is irrelevant and overlapping them is the
 * whole point (the CLI callback caps real concurrency + emits tree events). A
 * failure is isolated to its own tool reply (never rejects the batch), and
 * replies are pushed in submission order. Non-spawn tools are NOT part of a batch
 * (the caller treats them as ordering barriers), so an `edit` before a spawn is
 * applied first and the subagent reads post-edit state.
 */
async function runSpawnBatch(
  group: readonly IIndexedCall[],
  ctx: ILoopCtx
): Promise<void> {
  const results = await Promise.all(
    group.map(async ({ call }) => {
      try {
        return await executeTool(call, toolContextFor(ctx, ctx.report));
      } catch (err) {
        return `spawn_agent failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    })
  );

  group.forEach(({ call, index }, k) => {
    ctx.messages.push({
      role: "tool",
      content: results[k] ?? "",
      toolCallId: callKey(call, index),
    });
  });
}

/**
 * Run the model's tool calls in order, reporting whether any touched an editable
 * file (⇒ re-gate). A maximal run of consecutive `spawn_agent` calls executes
 * concurrently as one batch; every other tool runs sequentially and acts as an
 * ordering barrier, so tool effects (edits/mutations) never get reordered around
 * delegation.
 */
export async function runToolCalls(
  toolCalls: readonly IToolCall[],
  ctx: ILoopCtx,
  state: ILoopState
): Promise<boolean> {
  let touchedEditable = false;
  let i = 0;

  while (i < toolCalls.length) {
    const call = toolCalls[i];

    if (call === undefined) {
      i += 1;
      continue;
    }

    if (call.name === TOOL_NAME.spawnAgent) {
      const group: IIndexedCall[] = [];

      while (
        i < toolCalls.length &&
        toolCalls[i]?.name === TOOL_NAME.spawnAgent
      ) {
        const c = toolCalls[i];

        if (c !== undefined) {
          group.push({ call: c, index: i });
        }

        i += 1;
      }

      await runSpawnBatch(group, ctx);
      continue;
    }

    touchedEditable =
      (await runOneToolCall(call, i, ctx, state)) || touchedEditable;
    i += 1;
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
      } catch (err) {
        // degrade silently — the gate still runs below
        trace("applyDeterministicFixes.quickFix", err);
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

  let astFixed = 0;

  for (const f of files) {
    try {
      if (await fileExists(cwd, f)) {
        astFixed += await astGrepFix(join(cwd, f));
        // Backstop the write-time strip (covers files changed via rename/organize
        // or any path that skipped the write-guard).
        astFixed += await stripLiteralCasts(join(cwd, f));
      }
    } catch (err) {
      // degrade silently — gate is the authority
      trace("applyDeterministicFixes.astGrep", err);
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
  const { task, cwd, report } = ctx;
  const parse = ctx.gate.parse;

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
      } catch (err) {
        // degrade silently — we revalidate and revert below
        trace("applyDeterministicFixes.dropAnnotations", err);
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
      ctx.tool.signal === undefined ? {} : { signal: ctx.tool.signal }
    );
  }

  const recheck = await validate(
    task,
    cwd,
    parse,
    ctx.tool.signal === undefined ? {} : { signal: ctx.tool.signal }
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
    } catch (err) {
      // ignore — a file that can't be stat'd just isn't tracked
      trace("snapshotMtimes", err);
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
/** STEP 1 — deterministic auto-fix: run the janitor fixers (TS quick-fixes,
 *  ast-grep, the optional `task.fix` command) and return which files they changed,
 *  so the model is told exactly what moved under it (else it re-fixes already-
 *  fixed style and edits now-stale text → rejects). Exported for unit tests. */
export async function autoFixStep(ctx: ILoopCtx): Promise<string[]> {
  const { task, cwd, report } = ctx;
  const beforeFix = await snapshotMtimes(cwd, task.files);

  await applyDeterministicFixes(ctx);

  if (task.fix !== undefined && task.fix.length > 0) {
    await runAccept(
      { ...task, accept: task.fix },
      cwd,
      ctx.tool.signal === undefined ? {} : { signal: ctx.tool.signal }
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

  return autoFixed;
}

/** STEP 2 — run the gate command (tsc/eslint/tests/…): announce it on live
 *  streams, run `validate`, and flush any final newline-less output line. */
async function runGateStep(
  ctx: ILoopCtx,
  turn: number
): Promise<Awaited<ReturnType<typeof validate>>> {
  const { task, cwd, report } = ctx;
  const parse = ctx.gate.parse;

  if (ctx.gate.onGateChunk !== undefined) {
    report({
      kind: "tool",
      task: task.id,
      message: `⚙ running gate · turn ${turn}…`,
    });
  }

  const gate = await validate(task, cwd, parse, {
    ...(ctx.gate.onGateChunk === undefined
      ? {}
      : { onChunk: ctx.gate.onGateChunk }),
    ...(ctx.tool.signal === undefined ? {} : { signal: ctx.tool.signal }),
  });

  // The gate process has exited — flush any final newline-less line the stream
  // filter is still holding so it reaches the terminal.
  ctx.gate.onGateChunk?.flush?.();

  return gate;
}

/** STEP 3 — meta-rules: project structure invariants the gate command can't
 *  express (e.g. test-sibling-required), change-scoped to the files the AGENT
 *  wrote this session. Best-effort: a throwing rule degrades to no violations. */
function runMetaRulesStep(ctx: ILoopCtx): IMetaRuleViolation[] {
  try {
    // The files the AGENT created/edited this session — what change-scoped rules
    // (test-sibling-required) enforce on. This is the real signal, not git: it
    // works in any directory (including a freshly generated, non-git project) and
    // never blocks on the repo's pre-existing untested code.
    const changed = [...(ctx.tool.touched ?? [])];
    const metaContext = buildMetaRuleContext(
      ctx.cwd,
      ctx.gate.stackProfile?.packs ?? [],
      changed
    );

    return runMetaRules(META_RULES, metaContext, ctx.gate.ruleOverrides);
  } catch (err) {
    // Degrade silently — meta-rules are supplementary to the gate
    trace("runMetaRules", err);

    return [];
  }
}

/** A terminal STUCK result — shared shape for every convergence guard. */
function stuckResult(
  ctx: ILoopCtx,
  turn: number,
  detail: string,
  messagePrefix: string
): IRunResult {
  ctx.report({
    kind: "stuck",
    task: ctx.task.id,
    cycles: turn,
    detail,
    message: `task ${ctx.task.id}: ${messagePrefix}${detail}`,
  });

  return {
    task: ctx.task.id,
    redConfirmed: true,
    status: RUN_STATUS.stuck,
    cycles: turn,
    reason: STUCK_REASON.stalled,
    detail,
  };
}

/** Cap on expert-handoff attempts per run — the expert is a strong-model call, not
 *  free; a couple of rescues is plenty before a genuine park. */
const EXPERT_MAX_USES = 2;

/** Before accepting a stalled PARK, try the expert handoff (the rung ABOVE the
 *  steering ladder): hand the single most-blocking failing FILE to the configured
 *  `capabilities.expert` model, apply its fix, and let the primary model continue.
 *  Returns true when a fix was applied (→ keep looping). No expert configured, no
 *  failing file, the cap reached, or the expert declining all fall through to false
 *  (→ park as before). Never throws — a handoff hiccup must not crash the run. */
export async function tryExpertRescue(
  ctx: ILoopCtx,
  state: ILoopState,
  gateErrors: IErrorItem[],
  resolveAsk: () => Promise<ExpertAsk | null> = resolveExpertAsk
): Promise<boolean> {
  // Every bail is REPORTED — a silent skip here is what hid, for a whole run, WHY
  // the expert never fired (it turned out to be one of these branches). Now the log
  // always says why we parked instead of calling the expert.
  const skip = (why: string): false => {
    ctx.report({
      kind: "tool",
      task: ctx.task.id,
      message: `expert handoff skipped — ${why}; parking`,
    });

    return false;
  };

  if ((state.expertUses ?? 0) >= EXPERT_MAX_USES) {
    return skip(`already used ${String(EXPERT_MAX_USES)}× this run`);
  }

  // Resolve the file to repair: prefer a populated `.file`, else parse it from the
  // error MESSAGE (type-aware-lint names the file in text but doesn't set `.file` —
  // which skipped the expert on a whole live run). See resolveStuckFile.
  const targetFile = await resolveStuckFile(ctx.cwd, gateErrors);

  if (targetFile === null) {
    return skip("no file could be resolved from the failing error(s)");
  }

  const ask = await resolveAsk();

  if (ask === null) {
    return skip(
      "no expert model configured (set capabilities.expert in models.json)"
    );
  }

  const content = await Bun.file(join(ctx.cwd, targetFile))
    .text()
    .catch(() => "");
  // All error messages: file-less errors (type-aware-lint) can't be filtered by
  // file, and the extra context doesn't hurt the expert's single-file fix.
  const errorText = gateErrors.map((e) => e.message).join("\n");

  ctx.report({
    kind: "tool",
    task: ctx.task.id,
    message: `🆘 expert handoff: ${targetFile}`,
  });

  const outcome = await runExpertHandoff(
    ctx.cwd,
    { file: targetFile, content, error: errorText, goal: ctx.task.id },
    ask
  );

  ctx.report({ kind: "tool", task: ctx.task.id, message: outcome.note });

  if (!outcome.applied) {
    return false;
  }

  // The expert fixed it — give the primary model a fresh run at the ladder to
  // verify and finish (reset guards + steer level; count the rescue against the cap).
  state.expertUses = (state.expertUses ?? 0) + 1;
  state.steerLevel = 0;
  resetConvergenceGuards(state, gateErrors.length);
  // Rebase the plateau backstop too (fresh baseline after the expert's fix). This is
  // ONE of only two places it resets (here + a new all-time low) — deliberately NOT in
  // resetConvergenceGuards, or a steer escalation would reset the oscillation detector.
  state.redGates = 0;
  state.plateauBest = gateErrors.length;
  ctx.messages.push({
    role: "user",
    content: `An expert engineer just repaired \`${targetFile}\` for you. Run the gate to verify, then finish the remaining work.`,
  });

  return true;
}

/** Reset the convergence guards so the model gets fresh cycles after a steer
 *  escalation — else a guard that just tripped would trip again next cycle and
 *  race up the ladder in a few turns. Ages clear, the whole-set counter zeroes,
 *  and the net-progress watermark rebases to the current count (so any real drop
 *  from here counts as progress). */
function resetConvergenceGuards(state: ILoopState, errorCount: number): void {
  state.errorAge = new Map();
  state.gateNoProgress = 0;
  state.noNewLow = 0;
  state.bestErrorCount = errorCount;
}

/** STEP 4 — the three convergence guards, in escalating coarseness: a single
 *  (file,rule) persisting `samePersist` cycles; the WHOLE error set unchanged
 *  `gateStuckRepeats` cycles; and no new error-count low in `noProgressCycles`
 *  cycles. When one trips, the model has STALLED — but instead of killing the run
 *  (the old behaviour, which discarded hours of work on a wall it could climb with
 *  a nudge), we ESCALATE A STEER: a more directive message telling it to stop
 *  flailing and HOW to fix the rule it keeps failing. Only once the steer ladder is
 *  exhausted (`STEER_LADDER_MAX`) does the run park. Returns the terminal (park)
 *  result, or null to keep looping — with `state.pendingSteer` set when a steer
 *  should be injected this cycle. Exported for unit tests. */
export function checkStuck(
  ctx: ILoopCtx,
  state: ILoopState,
  gateErrors: IErrorItem[],
  turn: number
): IRunResult | null {
  // Advance ALL three trackers every cycle (they mutate state), then decide which,
  // if any, tripped — the coarsest-first order preserves the old diagnosis text.
  const persisted = trackErrorAges(state, gateErrors);

  state.gateNoProgress = sameErrorSet(state.prevGateErrors, gateErrors)
    ? state.gateNoProgress + 1
    : 0;
  state.prevGateErrors = gateErrors;

  // Update the net-progress watermark (mutates noNewLow / bestErrorCount).
  trackNetProgress(state, gateErrors.length);

  // PLATEAU tracker: count gate cycles since the last ALL-TIME-low error count. A new
  // low is genuine progress (reset); anything else — an error-set rotation, or a return
  // to a count already seen — is oscillation (climb). `plateauBest` is NEVER rebased on
  // escalation (unlike the fine guards' `bestErrorCount`), so re-reaching a count the
  // model already hit doesn't look like progress — which is exactly how a flailing model
  // evades the fine guards and crawls the ladder over 150+ turns. `redGates` DOES reset
  // on each escalation (below) so escalations stay spaced, but it climbs right back under
  // oscillation because no new all-time low arrives — driving the ladder to the expert in
  // a handful of gates instead of ~150 turns (observed live: v8 still L2 at turn 153).
  if (gateErrors.length < (state.plateauBest ?? Number.POSITIVE_INFINITY)) {
    state.plateauBest = gateErrors.length;
    state.redGates = 0;
  } else {
    state.redGates = (state.redGates ?? 0) + 1;
  }

  // Once steering has begun, the two coarse guards re-trip on a MUCH smaller window
  // (`steerRetrigger`) so the ladder actually climbs L1→L2→L3 within a few gates —
  // otherwise, over sparse forced-gates, the useful rungs (esp. the L2 playbook)
  // never arrive (observed live: only L1 by turn 105). The finer per-error guard
  // keeps its own threshold (it resets fully each escalation).
  const stalling = state.steerLevel > 0;
  const setCap = stalling
    ? LOOP_LIMITS.steerRetrigger
    : LOOP_LIMITS.gateStuckRepeats;
  const progressCap = stalling
    ? LOOP_LIMITS.steerRetrigger
    : LOOP_LIMITS.noProgressCycles;
  const wholeSetStuck = state.gateNoProgress >= setCap;
  const noNetProgress = state.noNewLow >= progressCap;
  // The plateau: no NEW ALL-TIME low for `plateauGates` gate cycles. This is the guard
  // the others miss — it drives escalation under oscillation (rotating error sets + a
  // count that bounces but never actually improves), so the ladder reaches the expert
  // fast instead of crawling. Checked LAST so the finer diagnoses win when they apply.
  const plateaued = (state.redGates ?? 0) >= LOOP_LIMITS.plateauGates;

  const reason =
    persisted !== null
      ? persistDetail(persisted)
      : wholeSetStuck
        ? `gate unchanged ${String(setCap)} cycles (${String(gateErrors.length)} error(s) not converging)`
        : noNetProgress
          ? `no net progress: ${String(gateErrors.length)} error(s) open, none cleared in ${String(progressCap)} cycles (best ${String(state.bestErrorCount)})`
          : plateaued
            ? `oscillating: ${String(gateErrors.length)} error(s) open, no NEW low in ${String(state.redGates ?? 0)} gate cycles (best ever ${String(state.plateauBest ?? 0)})`
            : null;

  if (reason === null) {
    return null; // still converging — keep looping normally
  }

  // Stalled. Escalate a steer and give the model fresh cycles at the new level. Reset the
  // plateau COUNTER too (spacing — one escalation per plateau window) but NOT plateauBest,
  // so oscillation keeps re-tripping it and the ladder climbs to the expert.
  state.steerLevel += 1;
  state.redGates = 0;
  resetConvergenceGuards(state, gateErrors.length);

  if (state.steerLevel > STEER_LADDER_MAX) {
    // Ladder exhausted — the run parks (an expert-model handoff slots in here).
    return stuckResult(
      ctx,
      turn,
      `${reason} — steering exhausted after ${String(STEER_LADDER_MAX)} escalations`,
      "parked — "
    );
  }

  state.pendingSteer = buildSteerMessage(
    state.steerLevel,
    gateErrors,
    reason,
    flags.webTools()
  );

  // At the TOP rung (change-strategy), also RESET the conversation: the flailing
  // history anchors the model to the dead-end approach it's been repeating. Pruning
  // to the essentials + a fresh directive breaks that "context poisoning" so the new
  // strategy isn't fighting the old transcript. injectFeedback does the actual prune.
  if (state.steerLevel >= STEER_LADDER_MAX) {
    state.resetContext = true;
  }

  ctx.report({
    kind: "tool",
    task: ctx.task.id,
    message: `⤴ steer L${String(state.steerLevel)}/${String(STEER_LADDER_MAX)}: ${reason}`,
  });

  return null; // keep looping, with the steer injected this cycle
}

/** STEP 5 — inject the red-gate feedback (rule docs + the auto-fix notice) into
 *  the conversation as the next user message, so the model fixes in-context.
 *  Exported for unit testing (like checkStuck/autoFixStep) — the convention PUSH
 *  delivery is a seam we need to assert actually reaches the model's messages. */
export async function injectFeedback(
  ctx: ILoopCtx,
  state: ILoopState,
  gateErrors: IErrorItem[],
  metaViolations: IMetaRuleViolation[],
  autoFixed: string[]
): Promise<void> {
  const feedback = await gateFeedback(
    gateErrors,
    ctx.task,
    ctx.cwd,
    metaViolations
  );
  const notice = autoFixed.length > 0 ? `${autoFixNotice(autoFixed)}\n\n` : "";
  // A pending steer (the model stalled) leads the feedback so it can't be missed,
  // then is cleared — it's a one-shot escalation for THIS cycle.
  const steer =
    state.pendingSteer !== undefined ? `${state.pendingSteer}\n\n` : "";

  state.pendingSteer = undefined;

  // Context reset (top steer rung): prune the poisoned transcript to its essentials
  // IN PLACE (keep the array reference the loop holds), so the fresh directive lands
  // on a clean slate instead of after dozens of dead-end turns.
  if (state.resetContext === true) {
    const before = ctx.messages.length;

    ctx.messages.splice(
      0,
      ctx.messages.length,
      ...essentialMessages(ctx.messages)
    );
    state.resetContext = false;
    // Observable (the reset used to be silent — the same blindness that hid the
    // expert bug): log that the poisoned transcript was pruned.
    ctx.report({
      kind: "tool",
      task: ctx.task.id,
      message: `↺ context reset — pruned ${String(before)} messages to ${String(ctx.messages.length)} (fresh start for the change-strategy rung)`,
    });
  }

  // PUSH the boringstack HOW-TO the first time a gate error maps to a convention —
  // right beside the error, not after the steering ladder escalates. Deduped per
  // run (once per topic), so it teaches without becoming a wall. Gated on the
  // backend's convention library (symmetric with the pull_conventions tool): a
  // plain build never gets boringstack-flavored guidance injected.
  state.pushedGuides ??= new Set<string>();
  const guides =
    state.conventionsEnabled === true
      ? unseenGuidesForErrors(gateErrors, state.pushedGuides)
      : [];
  const how =
    guides.length > 0
      ? `\n\nHOW TO WRITE THIS RIGHT (boringstack):\n${guides.join("\n\n")}`
      : "";

  // Observable (was silent — the same blindness that hid the expert bug and made it
  // impossible to tell from a build log whether the model was ever taught a
  // convention). Log which topics were pushed this cycle so adoption is measurable.
  if (guides.length > 0) {
    ctx.report({
      kind: "tool",
      task: ctx.task.id,
      message: `📐 pushed ${String(guides.length)} convention guide(s) beside the gate errors`,
    });
  }

  ctx.messages.push({
    role: "user",
    content: `${steer}${notice}${feedback}${how}`,
  });
}

/** Settle a turn against the gate: auto-fix → gate → meta-rules → (green? done :
 *  stuck-check → feedback). A thin orchestrator over the exported steps above —
 *  the signature and `IRunResult | null` contract (null ⇒ keep looping) are the
 *  same as ever, so both drivers (run.ts / session.ts) are untouched. */
export async function settleGate(
  ctx: ILoopCtx,
  state: ILoopState,
  turn: number
): Promise<IRunResult | null> {
  const { task, report } = ctx;
  const autoFixed = await autoFixStep(ctx);
  const gate = await runGateStep(ctx, turn);
  const metaViolations = runMetaRulesStep(ctx);

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

  const stuck = checkStuck(ctx, state, gateErrors, turn);

  if (stuck !== null) {
    // A stalled park is the rung where the EXPERT handoff gets a shot before we give
    // up: if a stronger model repairs the blocking file, keep looping instead of
    // parking. No expert configured → this is a no-op and the run parks as before.
    if (
      stuck.status === RUN_STATUS.stuck &&
      stuck.reason === STUCK_REASON.stalled &&
      (await tryExpertRescue(ctx, state, gateErrors))
    ) {
      return null;
    }

    return stuck;
  }

  await injectFeedback(ctx, state, gateErrors, metaViolations, autoFixed);

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
