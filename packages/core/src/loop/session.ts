import type {
  IChatMessage,
  IModelResponse,
  IProvider,
  ITokenUsage,
} from "../inference";
import type { ITask } from "../spec";
import type { FileLinter } from "../detect-gate";
import { SCAFFOLD_UI_TOOL } from "../agent";
import { readFiles } from "../lib/fs";
import { validate, type ErrorParser } from "../validate";
import { LOOP_LIMITS, RUN_STATUS } from "./loop.constants";
import type { Reporter } from "./loop.types";
import { CHAT_SYSTEM, COMPACT_SYSTEM } from "./prompt";
import {
  buildTsService,
  BUILD_NUDGE,
  emitTiming,
  type ILoopCtx,
  type ILoopState,
  NO_TOOL_CALL_NUDGE,
  runToolCalls,
  settleGate,
  toolsFor,
} from "./turn";

/**
 * A persistent, tool-using conversation against a working directory — the engine
 * behind the interactive CLI. Unlike `runTask` (one RED-first task driven to
 * green and returned), a Session lives across many user messages: each `send()`
 * runs the model until it stops calling tools, then — IF a gate is configured —
 * the deterministic gate confirms "done" (green = accept, red = errors fed back,
 * keep going). With no gate it's a plain conversational turn. Same `turn.ts`
 * primitives as `runTask`, so there is one tool-loop and one gate, not two.
 */
export interface ISessionConfig {
  provider: IProvider;
  /** Working directory the agent operates in. */
  cwd: string;
  /** Editable scope — edits/creates outside these are rejected. Empty = read-only. */
  files?: string[];
  /** Gate command. When set, a turn that ends without tool calls is gate-confirmed. */
  accept?: string;
  /** Auto-fix command run before re-validating (e.g. `eslint --fix`). */
  fix?: string;
  /** Read-only context files. */
  context?: string[];
  parse?: ErrorParser;
  report?: Reporter;
  temperature?: number;
  enableThinking?: boolean;
  thinkingTokenBudget?: number;
  /** Per-`send` turn cap (default LOOP_LIMITS.maxTurns). */
  maxTurns?: number;
  /** Resume from a saved conversation (incl. its system message) instead of
   *  starting fresh — used by `--continue`. */
  history?: IChatMessage[];
  /** Extra opinionated guidance appended to the system prompt (e.g. a scaffold's
   *  conventions: "this is a web app, the entry is app.ts…"). */
  guidance?: string;
  /** The model's context window (tokens). When set, the session auto-compacts
   *  before a send once the held context exceeds `autoCompactAt` of it. 0/unset
   *  disables auto-compaction. */
  contextWindow?: number;
  /** Fraction of `contextWindow` that triggers auto-compaction (default 0.8). */
  autoCompactAt?: number;
  /** A FAST check (e.g. `tsc --noEmit`) run every `checkEvery` edits WHILE the
   *  model is still building — so errors surface a few edits after they're made,
   *  not as a 100-error avalanche when it finally stops. Empty = off. */
  incrementalCheck?: string;
  /** Edits between incremental checks (default 3). */
  checkEvery?: number;
  /** Write-time single-file linter (the gate's eslint rules per write). When set,
   *  the write-guard reports lint violations — the moat rules tsc can't see (`as`,
   *  `I`-prefix) — inline, so they're fixed in-context not piled up at the gate. */
  lintFile?: FileLinter;
  /** Offer the `scaffold_ui` tool (themed UI primitives). Web builds only — keeps
   *  it off the pure-TS/scratch tool list where it's meaningless noise. */
  scaffoldUi?: boolean;
}

/** The outcome of one `send`. `responded` = conversational (no gate); the gate
 *  verdicts are `done`/`stuck` as in `runTask`; `interrupted` = the user aborted. */
export interface ISendResult {
  status: "responded" | "done" | "stuck" | "interrupted";
  turns: number;
}

export interface ISendOptions {
  /** Caller cancellation (Ctrl-C). */
  signal?: AbortSignal;
  /** Drained at each turn boundary — any returned strings are injected as user
   *  messages before the next model call, so the user can STEER a run in flight
   *  ("actually use Tailwind") without aborting it. */
  steer?: () => string[];
  /** Per-send thinking override (beats cfg.enableThinking for this send only).
   *  Used to keep thinking ON for the design phase (where reasoning earns its
   *  keep) but OFF for the mechanical implement phase, where ~25k tokens of
   *  pre-write reasoning per build is pure latency. */
  enableThinking?: boolean;
}

const SESSION_ID = "session";

/** Default share of the context window that triggers auto-compaction. */
const AUTO_COMPACT_AT = 0.8;

/** Staged-build step 1: design the type contract FIRST, gate off. Constraining
 *  the model to types before UI is the community-validated cure for random API
 *  invention on local models (plan → interfaces → implementation). */
const PLAN_TYPES_STEP =
  "STEP 1 of 2 — DESIGN FIRST, do not build the UI yet. In ONE short paragraph, " +
  "name the DOMAINS the app needs and the data each holds. Then lay out the type " +
  "contract the boringstack way: for each domain create its " +
  "`src/<domain>/<domain>.types.ts` (its `I`-prefixed interfaces) and, where it has " +
  "fixed registries/config, `src/<domain>/<domain>.constants.ts` (`as const`). Put " +
  "types shared across domains in `src/shared/shared.types.ts`. Do NOT create one " +
  "mega `src/types.ts`, and do NOT build components yet — types/constants only, then stop.\n" +
  "SPEED: after the one-paragraph plan, write MANY files per turn — emit SEVERAL " +
  "`create` tool calls in a SINGLE response (batch all of a domain's type/constant " +
  "files at once). Do NOT write one file then stop and wait.";

/** Default edits between incremental checks. */
const CHECK_EVERY = 3;

/** How many times a send recovers from a repetition loop before giving up. */
const MAX_DEGENERATION_RECOVERIES = 2;

/** How many times a send recovers from a model-request TIMEOUT before giving up.
 *  A single over-long turn (the model spiralled past the request timeout) must not
 *  throw away many turns of real progress — re-steer toward a small, fast turn and
 *  continue. Bounded so a server that's genuinely wedged still ends the run. */
const MAX_TIMEOUT_RECOVERIES = 2;

/** Pushed after a request timeout — the previous turn ran past the (generous)
 *  request timeout, almost always from too-long reasoning or one huge file. Demand
 *  a small, fast turn (paired with a forced, thinking-off tool call). */
const TIMEOUT_RESTEER =
  "Your previous response timed out — it ran too long (likely over-long reasoning " +
  "or one huge file). Make the SINGLE next tool call now: create or edit just ONE " +
  "file, kept small. Keep reasoning brief. No prose.";

/** True when an error is a request TIMEOUT (AbortSignal.timeout fires a
 *  `TimeoutError`), as opposed to a caller abort or a connection drop. */
function isModelTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  return err.name === "TimeoutError" || /timed out|timeout/i.test(err.message);
}

/** Pushed after a repetition loop — break the spiral by demanding ONE concrete
 *  action (paired with a forced tool call, which can't loop in prose). */
const REPETITION_RESTEER =
  "You started repeating yourself. STOP — do not re-explain or re-decide. Emit " +
  "the SINGLE next tool call that makes concrete progress (create or edit ONE " +
  "file). No prose.";

/** Prefaces interim-check feedback so the model fixes real errors and ignores the
 *  expected "module not found" noise from files it hasn't created yet. */
const INTERIM_CHECK_NOTE =
  "Interim type-check (NOT the final gate) — fix these now, while they are few, " +
  "before writing more. IGNORE any `Cannot find module './…'` for files you have " +
  "not created yet; fix the real type errors:";

/** Staged-build step 2: implement against the contract, gate on (drive to green). */
const IMPLEMENT_STEP =
  "STEP 2 of 2 — now build the app: import the types from the per-domain " +
  "`.types.ts` files you created and build the components/routes (ONE component " +
  "per FILE), wiring them together. The gate builds and verifies it in a real " +
  "browser; fix exactly what it reports until green.\n" +
  "SPEED: write MANY files per turn — emit SEVERAL `create` tool calls in a SINGLE " +
  "response (e.g. a whole domain's files at once: its components, hooks, service). " +
  "Do NOT write one file then stop and wait — batch aggressively, 5+ files a turn. " +
  "When fixing gate errors, fix ALL reported files in one turn (one `edit` each). " +
  "Don't explain or plan in prose — just emit the tool calls.";

/**
 * Did the model write whole files INTO its chat message instead of calling
 * `create`? Trips on ≥2 fenced code blocks (4 ``` markers), or one big block in
 * a long message — i.e. it dumped the app as prose. A single short illustrative
 * snippet in a chat answer does NOT trip it, so genuine Q&A is unaffected.
 */
function looksLikeCodeDump(content: string): boolean {
  const fences = (content.match(/```/g) ?? []).length;

  return fences >= 4 || (fences >= 2 && content.length > 1500);
}

/** CHAT_SYSTEM + a short orientation to the workspace and (optional) gate. */
function systemPrompt(cfg: ISessionConfig): string {
  const lines = [`Workspace: ${cfg.cwd}`];
  const files = cfg.files ?? [];
  const wholeRepo = files.length === 0 || files.includes("**/*");

  lines.push(
    wholeRepo
      ? "You may read, run, and edit any file in the workspace."
      : `You may only edit: ${files.join(", ")} (everything else is read-only).`
  );

  if (cfg.accept !== undefined && cfg.accept.length > 0) {
    lines.push(
      `A check is configured: \`${cfg.accept}\`. When you finish a change and ` +
        "stop calling tools, it runs automatically — if it fails you'll get the " +
        "errors and should fix them and continue until it passes."
    );
  }

  if (cfg.guidance !== undefined && cfg.guidance.length > 0) {
    lines.push(cfg.guidance);
  }

  return `${CHAT_SYSTEM}\n\n${lines.join("\n")}`;
}

export class Session {
  private readonly provider: IProvider;
  private readonly cfg: ISessionConfig;
  private readonly report: Reporter;
  private readonly tools: (
    | ReturnType<typeof toolsFor>[number]
    | typeof SCAFFOLD_UI_TOOL
  )[];
  private hasGate: boolean;
  private readonly ctx: ILoopCtx;
  private readonly state: ILoopState;
  /** Token usage from the most recent model call — `promptTokens` is the real
   *  size of the context the model last saw (drives the status gauge and, soon,
   *  auto-compaction). */
  private lastUsage?: ITokenUsage;
  /** Fast check run every few edits while building (e.g. tsc); "" = off. */
  private incrementalCheck: string;
  /** Per-send thinking override, set from ISendOptions for the duration of a
   *  `send` (cleared after). Lets the design phase think and the implement phase
   *  not. Undefined = fall back to cfg.enableThinking (server default). */
  private activeThinking?: boolean;
  /** ADAPTIVE THINKING: true while the model has outstanding errors to fix (an
   *  interim check or the gate came back RED). Measured: ~80% of build time is
   *  REPAIR, and thinking-OFF repair oscillates and never converges (churns to the
   *  turn cap), while thinking-ON repair converges. So we think ONLY while
   *  repairing — fast thinking-off creation, convergent thinking-on repair. */
  private repairing = false;

  private constructor(cfg: ISessionConfig, ctx: ILoopCtx) {
    this.provider = cfg.provider;
    this.cfg = cfg;
    this.report = cfg.report ?? ((): void => undefined);
    this.hasGate = cfg.accept !== undefined && cfg.accept.length > 0;
    this.incrementalCheck = cfg.incrementalCheck ?? "";
    // Start with the 4 BASE tools (read/run/edit/create). Measured: the bigger
    // 11-tool list pushes this model onto a malformed-tool-call boundary (it
    // emits unparseable formats the server leaves in content) — see
    // malformed-toolcall-format. The base tools are enough to work a repo; the
    // LSP nav set can become an opt-in once we confirm it parses cleanly here.
    // WEB builds add ONE coarse tool — `scaffold_ui` — so the model generates
    // tested themed primitives instead of re-authoring a button/card every build.
    this.tools =
      cfg.scaffoldUi === true
        ? [...toolsFor(false), SCAFFOLD_UI_TOOL]
        : toolsFor(false);
    this.ctx = ctx;
    this.state = {
      prevGateErrors: [],
      gateNoProgress: 0,
      lastGateCount: -1,
      edits: 0,
      regressions: 0,
    };
  }

  /** Build a session (async because it spins up the TS LanguageService). */
  static async create(cfg: ISessionConfig): Promise<Session> {
    const task: ITask = {
      id: SESSION_ID,
      accept: cfg.accept ?? "",
      files: cfg.files ?? [],
      context: cfg.context,
      fix: cfg.fix,
    };

    const report = cfg.report ?? ((): void => undefined);
    const ctx: ILoopCtx = {
      task,
      cwd: cfg.cwd,
      tsService: await buildTsService(cfg.cwd),
      ...(cfg.lintFile === undefined ? {} : { lintFile: cfg.lintFile }),
      parse: cfg.parse,
      report,
      messages:
        cfg.history !== undefined && cfg.history.length > 0
          ? [...cfg.history]
          : [{ role: "system", content: systemPrompt(cfg) }],
      // Stream the gate's output live (the interactive CLI), so a slow gate
      // (vite build + chromium) shows progress instead of running silently.
      onGateChunk: (text) => {
        report({ kind: "token", task: SESSION_ID, message: text });
      },
    };

    return new Session(cfg, ctx);
  }

  /** The current gate command (empty when none). */
  get gate(): string {
    return this.ctx.task.accept;
  }

  /** The editable scope globs. */
  get scope(): string[] {
    return this.ctx.task.files;
  }

  /** Real token usage of the most recent model call (undefined until the first
   *  call, or if the server reports none). */
  get usage(): ITokenUsage | undefined {
    return this.lastUsage;
  }

  /** The real size of the context the model is currently holding — the prompt
   *  tokens of the last call (what auto-compaction watches), 0 before any call. */
  get contextTokens(): number {
    return this.lastUsage?.promptTokens ?? 0;
  }

  /** If the held context is at/over the auto-compact threshold, the percent full
   *  (for the notice); otherwise undefined. Needs a known window AND real usage
   *  from a prior turn — both absent on the first send, so it never fires early. */
  private autoCompactPct(): number | undefined {
    const window = this.cfg.contextWindow ?? 0;

    if (window <= 0 || this.lastUsage === undefined) {
      return undefined;
    }

    const fraction = this.lastUsage.promptTokens / window;
    const threshold = this.cfg.autoCompactAt ?? AUTO_COMPACT_AT;

    return fraction >= threshold ? Math.round(fraction * 100) : undefined;
  }

  /** Set (or clear, with "") the gate command mid-session. */
  setGate(command: string): void {
    this.ctx.task.accept = command;
    this.hasGate = command.length > 0;
  }

  /** Set (or clear, with "") the auto-fix command run before each gate — e.g. a
   *  scaffold's `eslint --fix`, so mechanical lint violations are squashed
   *  deterministically instead of costing the model turns. */
  setFix(command: string): void {
    this.ctx.task.fix = command.length > 0 ? command : undefined;
  }

  /** Set (or clear, with "") the fast incremental check (e.g. `tsc --noEmit`) run
   *  every few edits while building, so errors surface early instead of piling up. */
  setIncrementalCheck(command: string): void {
    this.incrementalCheck = command;
  }

  /** Replace the editable scope globs mid-session. */
  setScope(globs: string[]): void {
    this.ctx.task.files = globs;
  }

  /** Append opinionated guidance to the SYSTEM prompt (e.g. after classifying a
   *  fresh request as a web build). Folded into the existing system message — a
   *  second system message breaks some chat templates (Qwen → 400). */
  guide(text: string): void {
    const first = this.ctx.messages[0];

    if (first?.role === "system") {
      first.content = `${first.content}\n\n${text}`;
    } else {
      this.ctx.messages.unshift({ role: "system", content: text });
    }
  }

  /**
   * Compress the conversation: ask the model to summarize everything so far, then
   * replace the history with [system, summary]. Frees context for long sessions
   * while preserving goals/decisions/changes. Returns the message count before/after.
   */
  async compact(
    signal?: AbortSignal
  ): Promise<{ before: number; after: number }> {
    const { ctx } = this;
    const before = ctx.messages.length;
    const conversation = ctx.messages.filter((m) => m.role !== "system");

    if (conversation.length === 0) {
      return { before, after: before };
    }

    const transcript = conversation
      .map((m) => `[${m.role}] ${m.content}`)
      .join("\n\n");
    const res = await this.provider.complete(
      [
        { role: "system", content: COMPACT_SYSTEM },
        { role: "user", content: transcript },
      ],
      { temperature: 0, ...(signal === undefined ? {} : { signal }) }
    );

    const system = ctx.messages[0];
    const summary: IChatMessage = {
      role: "user",
      content: `[Summary of the earlier conversation]\n${res.content}`,
    };

    ctx.messages = system?.role === "system" ? [system, summary] : [summary];

    return { before, after: ctx.messages.length };
  }

  /** The live conversation (system + every exchange). Read-only view. */
  get messages(): readonly IChatMessage[] {
    return this.ctx.messages;
  }

  /**
   * Run one user message: drive the model until it stops calling tools, then
   * gate-confirm if a gate is set. Loops on red gate feedback up to the turn cap.
   */
  async send(text: string, opts: ISendOptions = {}): Promise<ISendResult> {
    const { ctx, report } = this;
    const maxTurns = this.cfg.maxTurns ?? LOOP_LIMITS.maxTurns;
    const sendStart = performance.now();

    // Thread cancellation to the tool `run` commands and the gate (not just the
    // model call), so Ctrl-C kills in-flight child processes too.
    ctx.signal = opts.signal;
    this.activeThinking = opts.enableThinking;
    this.repairing = false; // fresh send starts in (fast, thinking-off) creation mode

    try {
      // Auto-compact BEFORE adding the new message (so it stays a fresh turn
      // after the summary) when the held context is near the window.
      const pct = this.autoCompactPct();

      if (pct !== undefined) {
        report({
          kind: "tool",
          task: SESSION_ID,
          message: `⊙ context ~${pct}% full — auto-compacting to free room`,
        });

        const { before, after } = await this.compact(opts.signal);

        report({
          kind: "tool",
          task: SESSION_ID,
          message: `⊙ compacted ${before} → ${after} messages`,
        });
      }

      ctx.messages.push({ role: "user", content: text });

      return await this.drive(maxTurns, sendStart, opts);
    } catch (err) {
      if (opts.signal?.aborted === true) {
        report({
          kind: "stuck",
          task: SESSION_ID,
          message: "interrupted",
        });

        return { status: "interrupted", turns: 0 };
      }

      // A provider/network error (request timeout, connection drop after retries)
      // ends the turn GRACEFULLY as stuck — never crash the process. The message
      // is logged so it's visible/debuggable, not silently swallowed. This keeps a
      // long autonomous run (and the interactive CLI) alive through a flaky model.
      const detail = err instanceof Error ? err.message : String(err);

      report({
        kind: "stuck",
        task: SESSION_ID,
        message: `⚠ model request failed: ${detail}`,
      });

      return { status: "stuck", turns: 0 };
    } finally {
      ctx.signal = undefined;
      this.activeThinking = undefined;
    }
  }

  /**
   * Build a project from scratch in two STAGES, the way local models stay
   * reliable: (1) plan + write the type contract (`src/types.ts`) with the gate
   * OFF — a types-only app can't build yet, so gating here would spuriously fail;
   * (2) implement against those types with the gate ON, driving to green. This is
   * the community-validated plan→interfaces→implementation pattern; our gate is
   * the verification stage. A soft constraint: if the model ignores step 1 and
   * builds everything, step 2 simply continues — nothing breaks.
   */
  async buildStaged(
    request: string,
    opts: ISendOptions = {},
    designGate = ""
  ): Promise<ISendResult> {
    const gate = this.ctx.task.accept;

    // Phase 1 gates on TYPES only (tsc + lint, no build) when a designGate is
    // given — so the type contract is driven self-consistent BEFORE components,
    // catching the as-const↔interface errors small instead of as a final pile.
    this.setGate(designGate);
    const planned = await this.send(`${request}\n\n${PLAN_TYPES_STEP}`, opts);

    this.setGate(gate);

    // Don't push on to implementation if the user aborted the design step.
    if (planned.status === "interrupted") {
      return planned;
    }

    // Inject the EXACT type contract the design phase just wrote, fresh, right
    // before implementation. The 27b's #1 first-pass error is misremembering its
    // OWN types across many files/turns (a field shape it defined 30 turns ago) —
    // re-showing the precise current signatures cuts those consistency errors (so
    // less repair). Both phases run ADAPTIVE thinking (governed by `repairing`).
    const contract = await this.typeContract();

    return this.send(`${contract}${IMPLEMENT_STEP}`, opts);
  }

  /** Read the per-domain `.types.ts`/`.constants.ts` the design phase wrote and
   *  format them as a precise reference block for the implement phase — so the
   *  model builds against the EXACT current signatures instead of its (lossy)
   *  recollection of them. Empty string if none exist yet (nothing to anchor). */
  private async typeContract(): Promise<string> {
    const files = await readFiles(this.ctx.cwd, [
      "src/**/*.types.ts",
      "src/**/*.constants.ts",
    ]);

    if (files.length === 0) {
      return "";
    }

    const blocks = files
      .map((f) => `// ${f.path}\n${f.content.trim()}`)
      .join("\n\n");

    return (
      "THE TYPE CONTRACT you just designed (use these EXACT names/shapes — do " +
      "NOT invent or misremember fields; import from these paths):\n\n```ts\n" +
      `${blocks}\n` +
      "```\n\n"
    );
  }

  /** Once `editsSinceCheck` reaches the threshold, run the incremental check and
   *  reset the counter; otherwise pass it through. Keeps `drive` branch-light. */
  private async checkAfterEdits(
    editsSinceCheck: number,
    checkEvery: number
  ): Promise<number> {
    if (editsSinceCheck < checkEvery) {
      return editsSinceCheck;
    }

    await this.runIncrementalCheck();

    return 0;
  }

  /** Run the fast incremental check (e.g. tsc) and, if it surfaces errors, feed
   *  them back NOW as a user message so the model fixes them before writing more
   *  — instead of letting them pile up for the final gate. No-op when unset. */
  private async runIncrementalCheck(): Promise<void> {
    if (this.incrementalCheck.length === 0) {
      return;
    }

    const { ctx } = this;
    const task: ITask = { ...ctx.task, accept: this.incrementalCheck };
    const result = await validate(
      task,
      ctx.cwd,
      ctx.parse,
      ctx.signal === undefined ? {} : { signal: ctx.signal }
    );

    if (result.passed) {
      this.repairing = false; // clean → back to fast thinking-off creation

      return;
    }

    this.repairing = true; // errors outstanding → next turns think to converge

    const detail = result.errors
      .slice(0, 20)
      .map((e) => e.message)
      .join("\n");

    // Surface the ACTUAL errors into the log (not just the count) — so we can see
    // WHAT the model fails at and target the systematic ones in the harness.
    ctx.report({
      kind: "tool",
      task: SESSION_ID,
      message: `⊙ interim check: ${String(result.errors.length)} error(s) — fixing now:\n${detail}`,
    });

    ctx.messages.push({
      role: "user",
      content: `${INTERIM_CHECK_NOTE}\n${detail}`,
    });
  }

  /** The turn loop — separated so `send` can wrap it in abort handling. */
  /** One model call: stream thinking live, push the reply, and surface salvage +
   *  the highlighted answer. Keeps `drive`'s per-turn control flow lean. */
  private async askModel(
    signal?: AbortSignal,
    toolChoice: "auto" | "required" = "auto",
    forceNoThinking = false
  ): Promise<IModelResponse> {
    const { ctx, report } = this;
    // On a FORCED tool turn, disable thinking: the model already decided what to
    // do, and thinking-on is a known source of prose-before-the-call malformed
    // output on this model. `required` + thinking-off = the cleanest tool call.
    // ADAPTIVE: think while REPAIRING (errors outstanding) so repair converges;
    // otherwise honour the per-send/cfg setting (off = fast creation). A forced
    // recovery turn always thinks-off (it just needs one clean tool call).
    const enableThinking = forceNoThinking
      ? false
      : this.repairing
        ? true
        : (this.activeThinking ?? this.cfg.enableThinking);
    const res = await this.provider.complete(ctx.messages, {
      tools: this.tools,
      temperature: this.cfg.temperature ?? 0,
      toolChoice,
      ...(enableThinking === undefined ? {} : { enableThinking }),
      ...(this.cfg.thinkingTokenBudget === undefined
        ? {}
        : { thinkingTokenBudget: this.cfg.thinkingTokenBudget }),
      ...(signal === undefined ? {} : { signal }),
      onToken: (token, channel) => {
        // Stream the model's thinking AND the tool calls it's writing (the files)
        // live — so a long generation shows progress instead of a frozen cursor.
        // `content` is rendered once, formatted, when the turn settles. The
        // `channel` lets the renderer collapse reasoning to a compact indicator
        // (the raw text still reaches the --log).
        if (channel === "reasoning" || channel === "tool") {
          report({ kind: "token", task: SESSION_ID, message: token, channel });
        }
      },
    });

    if (res.usage !== undefined) {
      this.lastUsage = res.usage;
      // Logged (not shown) so the --log analyzer can compute tokens-to-solution.
      report({
        kind: "usage",
        task: SESSION_ID,
        message: `tokens ${res.usage.promptTokens} in / ${res.usage.completionTokens} out`,
        promptTokens: res.usage.promptTokens,
        completionTokens: res.usage.completionTokens,
        totalTokens: res.usage.totalTokens,
      });
    }

    ctx.messages.push({
      role: "assistant",
      content: res.content,
      toolCalls: res.toolCalls,
    });

    if (res.salvaged !== undefined && res.salvaged > 0) {
      report({
        kind: "tool",
        task: SESSION_ID,
        message: `⚠ recovered ${res.salvaged} malformed tool call(s) (server tool-call parser mismatch)`,
      });
    }

    if (res.content.length > 0) {
      report({ kind: "message", task: SESSION_ID, message: res.content });
    }

    return res;
  }

  /**
   * Decide what a turn that ended with NO tool calls (and no edits yet this send)
   * means. A plain answer — no gate, or a conversational reply — is `responded`.
   * But with a gate set and the reply DUMPING whole files as prose (instead of
   * calling `create`), that's the narrate-instead-of-build failure: the content
   * never reaches disk. We nudge it to act (`result: null`, capped); past the cap
   * we stop honestly rather than loop forever. Side effects (the nudge message,
   * the stuck report) happen here; the caller only emits timing and loops/returns.
   */
  private resolveNoEditYield(
    content: string,
    turn: number,
    buildNudges: number
  ): { result: ISendResult | null } {
    if (!this.hasGate || !looksLikeCodeDump(content)) {
      return { result: { status: "responded", turns: turn } };
    }

    if (buildNudges >= LOOP_LIMITS.maxBuildNudges) {
      this.report({
        kind: "stuck",
        task: SESSION_ID,
        message:
          "⚠ model kept writing files as chat messages instead of creating " +
          "them — stopped. Try a smaller step (e.g. one file at a time).",
      });

      return { result: { status: "stuck", turns: turn } };
    }

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: "↳ no files written — nudging the model to build with tools",
    });
    this.ctx.messages.push({ role: "user", content: BUILD_NUDGE });

    return { result: null };
  }

  /** Handle a repetition-loop detection: stop (return a stuck result) once the
   *  recovery budget is spent, else re-steer toward one concrete action and
   *  return null so the caller forces a tool call next turn. */
  private degenerationRecovery(
    degenerations: number,
    turn: number
  ): ISendResult | null {
    if (degenerations >= MAX_DEGENERATION_RECOVERIES) {
      this.report({
        kind: "stuck",
        task: SESSION_ID,
        message:
          "⚠ repetition loop persisted after recovery attempts — stopped. Try a smaller step.",
      });

      return { status: "stuck", turns: turn };
    }

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: "⚠ repetition loop — forcing a concrete next action",
    });
    this.ctx.messages.push({ role: "user", content: REPETITION_RESTEER });

    return null;
  }

  /** Handle a thrown model call: rethrow a caller abort or any non-timeout error
   *  (terminal — send()'s handler turns it into interrupted/stuck). A request
   *  TIMEOUT is recoverable: emit timing, then stop (return stuck) once the budget
   *  is spent, else re-steer toward a small fast turn and return null so the caller
   *  forces a (thinking-off) tool call and CONTINUES — preserving the turns already
   *  done rather than abandoning the whole build on one over-long turn. */
  private recoverFromTimeout(
    err: unknown,
    timeouts: number,
    turn: number,
    turnStart: number,
    sendStart: number,
    signal?: AbortSignal
  ): ISendResult | null {
    if (signal?.aborted === true || !isModelTimeout(err)) {
      throw err;
    }

    emitTiming(this.report, SESSION_ID, turn, turnStart, sendStart);

    // Log the RAW error so the timeout's true source (request-timeout ceiling vs a
    // server-side stream close) is diagnosable from the --log, not swallowed.
    const detail =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);

    if (timeouts >= MAX_TIMEOUT_RECOVERIES) {
      this.report({
        kind: "stuck",
        task: SESSION_ID,
        message: `⚠ model request timed out repeatedly (${detail}) — stopped. The server may be wedged or the task too large for one turn.`,
      });

      return { status: "stuck", turns: turn };
    }

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: `⚠ model request timed out (${detail}) — re-steering to a smaller turn and continuing (${String(timeouts + 1)}/${String(MAX_TIMEOUT_RECOVERIES)})`,
    });
    this.ctx.messages.push({ role: "user", content: TIMEOUT_RESTEER });

    return null;
  }

  /** Inject any messages the user typed mid-run (steering) before the next turn. */
  private injectSteer(steer?: () => string[]): void {
    for (const message of steer?.() ?? []) {
      this.ctx.messages.push({ role: "user", content: message });
      this.report({
        kind: "tool",
        task: SESSION_ID,
        message: `↳ steering: ${message.slice(0, 60)}`,
      });
    }
  }

  /** One model turn for `drive`, with timeout recovery folded in so the loop body
   *  stays lean: `ok` → use the response; `stop` → terminal result; `retry` →
   *  timed out, re-steer applied, force a small tool call next turn. A caller abort
   *  or non-timeout error propagates (via recoverFromTimeout) to send()'s handler. */
  private async acquireResponse(
    forceTool: boolean,
    timeouts: number,
    turn: number,
    turnStart: number,
    sendStart: number,
    opts: ISendOptions
  ): Promise<
    | { kind: "ok"; res: IModelResponse }
    | { kind: "stop"; result: ISendResult }
    | { kind: "retry" }
  > {
    try {
      const res = await this.askModel(
        opts.signal,
        forceTool ? "required" : "auto",
        forceTool // forced tool turn → also disable thinking for a clean call
      );

      return { kind: "ok", res };
    } catch (err) {
      const recovered = this.recoverFromTimeout(
        err,
        timeouts,
        turn,
        turnStart,
        sendStart,
        opts.signal
      );

      return recovered !== null
        ? { kind: "stop", result: recovered }
        : { kind: "retry" };
    }
  }

  /** Run the tool calls of a turn, account the edits, emit timing, and run the
   *  incremental check every few edits — returns the updated edit accounting so
   *  `drive`'s loop body stays lean. */
  private async runEditTurn(
    res: IModelResponse,
    acc: { edited: boolean; editsSinceCheck: number; checkEvery: number },
    turn: number,
    turnStart: number,
    sendStart: number
  ): Promise<{ edited: boolean; editsSinceCheck: number }> {
    const { ctx, state, report } = this;
    const before = state.edits;
    const edited =
      (await runToolCalls(res.toolCalls, ctx, state)) || acc.edited;

    emitTiming(report, SESSION_ID, turn, turnStart, sendStart);

    // Check every few edits WHILE building, so errors surface early instead of
    // piling up into a final avalanche the model can't dig out of.
    const editsSinceCheck = await this.checkAfterEdits(
      acc.editsSinceCheck + (state.edits - before),
      acc.checkEvery
    );

    return { edited, editsSinceCheck };
  }

  /** Run the gate once the model has stopped after editing: a terminal result
   *  (done/stuck) or null when still red (drive then pushes feedback + continues).
   *  Keeps the done/stuck mapping out of `drive`'s loop body. */
  private async settleTurn(
    turn: number,
    turnStart: number,
    sendStart: number
  ): Promise<ISendResult | null> {
    const settled = await settleGate(this.ctx, this.state, turn);

    emitTiming(this.report, SESSION_ID, turn, turnStart, sendStart);

    if (settled === null) {
      return null;
    }

    return {
      status: settled.status === RUN_STATUS.done ? "done" : "stuck",
      turns: turn,
    };
  }

  private async drive(
    maxTurns: number,
    sendStart: number,
    opts: ISendOptions
  ): Promise<ISendResult> {
    const { ctx, report } = this;
    // The gate confirms CHANGES, not answers: it fires only once the model has
    // actually edited a file this turn. So a pure question never triggers a gate
    // run (even with one configured) — and an auto-detected gate stays unobtrusive.
    let edited = false;
    // How many times this send the model dumped file contents as a chat message
    // instead of calling `create` (the narrate-instead-of-build failure).
    let buildNudges = 0;
    // Set after we nudge a narrating model: on the NEXT turn we FORCE a tool call
    // (tool_choice "required") instead of "auto". vLLM's required path follows the
    // tool schema strictly — so the model can't narrate (or emit malformed tool
    // syntax) again on a turn where we already know a tool call is the move.
    let forceTool = false;
    // Times the stream degenerated into a repetition loop this send — we try a
    // bounded recovery (force a concrete tool call) before giving up.
    let degenerations = 0;
    // Times a model request timed out this send — a single over-long turn must not
    // throw away prior progress; we re-steer to a small turn and continue.
    let timeouts = 0;
    // Edits since the last incremental check — drives "check every few edits".
    let editsSinceCheck = 0;
    const checkEvery = this.cfg.checkEvery ?? CHECK_EVERY;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const turnStart = performance.now();

      // Inject any messages the user typed while the run was in flight, so they
      // steer the next model turn instead of waiting for the run to finish.
      this.injectSteer(opts.steer);

      report({
        kind: "cycle",
        task: SESSION_ID,
        cycle: turn,
        message: `turn ${turn}: asking model`,
      });

      // Ask the model, recovering from a request timeout (re-steer + continue,
      // keeping prior turns) instead of abandoning the whole build on one over-long
      // turn. A caller abort or any other error propagates to send()'s handler.
      const ask = await this.acquireResponse(
        forceTool,
        timeouts,
        turn,
        turnStart,
        sendStart,
        opts
      );

      if (ask.kind === "stop") {
        return ask.result;
      }

      if (ask.kind === "retry") {
        timeouts += 1;
        forceTool = true; // next turn: forced, thinking-off → a small clean call

        continue;
      }

      const res = ask.res;

      forceTool = false;

      // The stream caught a degenerate repetition loop. Try a BOUNDED recovery
      // (force a concrete tool call next turn — can't loop in prose) before
      // giving up; see degenerationRecovery.
      if (res.degenerated === true) {
        const stop = this.degenerationRecovery(degenerations, turn);

        emitTiming(report, SESSION_ID, turn, turnStart, sendStart);

        if (stop !== null) {
          return stop;
        }

        degenerations += 1;
        forceTool = true;

        continue;
      }

      // Still working — run the calls and keep going (we gate only when it stops).
      if (res.toolCalls.length > 0) {
        ({ edited, editsSinceCheck } = await this.runEditTurn(
          res,
          { edited, editsSinceCheck, checkEvery },
          turn,
          turnStart,
          sendStart
        ));

        continue;
      }

      // The model yielded with no tool calls. With no gate it's a conversational
      // reply; with a gate but no edits this send, decide whether that's a real
      // answer or the narrate-instead-of-build failure (see resolveNoEditYield).
      if (!this.hasGate || !edited) {
        const outcome = this.resolveNoEditYield(res.content, turn, buildNudges);

        emitTiming(report, SESSION_ID, turn, turnStart, sendStart);

        if (outcome.result !== null) {
          return outcome.result;
        }

        buildNudges += 1;
        forceTool = true; // it just narrated code — force a tool call next turn

        continue;
      }

      // Gate confirms. Green/stuck ⇒ terminal; null ⇒ red, feedback pushed.
      const settled = await this.settleTurn(turn, turnStart, sendStart);

      if (settled !== null) {
        return settled;
      }

      // Gate came back RED → enter repair mode (think to converge on the fix).
      this.repairing = true;

      // Stopped while still red without acting → nudge it to act, not narrate,
      // and FORCE a tool call on the next turn so it can't narrate again.
      ctx.messages.push({ role: "user", content: NO_TOOL_CALL_NUDGE });
      forceTool = true;
    }

    report({
      kind: "stuck",
      task: SESSION_ID,
      cycles: maxTurns,
      message: `stuck (hit ${maxTurns}-turn cap)`,
    });

    return { status: "stuck", turns: maxTurns };
  }
}
