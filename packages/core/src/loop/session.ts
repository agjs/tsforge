import type { IChatMessage, IModelResponse, IProvider } from "../inference";
import type { ITask } from "../spec";
import type { ErrorParser } from "../validate";
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
}

const SESSION_ID = "session";

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
  private readonly tools: ReturnType<typeof toolsFor>;
  private hasGate: boolean;
  private readonly ctx: ILoopCtx;
  private readonly state: ILoopState;

  private constructor(cfg: ISessionConfig, ctx: ILoopCtx) {
    this.provider = cfg.provider;
    this.cfg = cfg;
    this.report = cfg.report ?? ((): void => undefined);
    this.hasGate = cfg.accept !== undefined && cfg.accept.length > 0;
    // Start with the 4 BASE tools (read/run/edit/create). Measured: the bigger
    // 11-tool list pushes this model onto a malformed-tool-call boundary (it
    // emits unparseable formats the server leaves in content) — see
    // malformed-toolcall-format. The base tools are enough to work a repo; the
    // LSP nav set can become an opt-in once we confirm it parses cleanly here.
    this.tools = toolsFor(false);
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

  /** Set (or clear, with "") the gate command mid-session. */
  setGate(command: string): void {
    this.ctx.task.accept = command;
    this.hasGate = command.length > 0;
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

    ctx.messages.push({ role: "user", content: text });

    const sendStart = performance.now();

    // Thread cancellation to the tool `run` commands and the gate (not just the
    // model call), so Ctrl-C kills in-flight child processes too.
    ctx.signal = opts.signal;

    try {
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

      throw err;
    } finally {
      ctx.signal = undefined;
    }
  }

  /** The turn loop — separated so `send` can wrap it in abort handling. */
  /** One model call: stream thinking live, push the reply, and surface salvage +
   *  the highlighted answer. Keeps `drive`'s per-turn control flow lean. */
  private async askModel(signal?: AbortSignal): Promise<IModelResponse> {
    const { ctx, report } = this;
    const res = await this.provider.complete(ctx.messages, {
      tools: this.tools,
      temperature: this.cfg.temperature ?? 0,
      toolChoice: "auto",
      ...(this.cfg.enableThinking === undefined
        ? {}
        : { enableThinking: this.cfg.enableThinking }),
      ...(this.cfg.thinkingTokenBudget === undefined
        ? {}
        : { thinkingTokenBudget: this.cfg.thinkingTokenBudget }),
      ...(signal === undefined ? {} : { signal }),
      onToken: (token, channel) => {
        // Stream the model's thinking AND the tool calls it's writing (the files)
        // live — so a long generation shows progress instead of a frozen cursor.
        // `content` is rendered once, formatted, when the turn settles.
        if (channel === "reasoning" || channel === "tool") {
          report({ kind: "token", task: SESSION_ID, message: token });
        }
      },
    });

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

  private async drive(
    maxTurns: number,
    sendStart: number,
    opts: ISendOptions
  ): Promise<ISendResult> {
    const { ctx, state, report } = this;
    // The gate confirms CHANGES, not answers: it fires only once the model has
    // actually edited a file this turn. So a pure question never triggers a gate
    // run (even with one configured) — and an auto-detected gate stays unobtrusive.
    let edited = false;
    // How many times this send the model dumped file contents as a chat message
    // instead of calling `create` (the narrate-instead-of-build failure).
    let buildNudges = 0;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const turnStart = performance.now();

      // Inject any messages the user typed while the run was in flight, so they
      // steer the next model turn instead of waiting for the run to finish.
      for (const message of opts.steer?.() ?? []) {
        ctx.messages.push({ role: "user", content: message });
        report({
          kind: "tool",
          task: SESSION_ID,
          message: `↳ steering: ${message.slice(0, 60)}`,
        });
      }

      report({
        kind: "cycle",
        task: SESSION_ID,
        cycle: turn,
        message: `turn ${turn}: asking model`,
      });

      const res = await this.askModel(opts.signal);

      // The stream caught a degenerate repetition loop and aborted it. Don't
      // nudge into another loop — stop the turn so the user can re-steer.
      if (res.degenerated === true) {
        report({
          kind: "stuck",
          task: SESSION_ID,
          message:
            "⚠ model fell into a repetition loop — stopped. Try rephrasing, or break the task into a smaller step.",
        });

        return { status: "stuck", turns: turn };
      }

      // Still working — run the calls and keep going (we gate only when it stops).
      if (res.toolCalls.length > 0) {
        edited = (await runToolCalls(res.toolCalls, ctx, state)) || edited;
        emitTiming(report, SESSION_ID, turn, turnStart, sendStart);
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

        continue;
      }

      // Gate confirms. Green/stuck ⇒ terminal; null ⇒ red, feedback pushed.
      const settled = await settleGate(ctx, state, turn);

      emitTiming(report, SESSION_ID, turn, turnStart, sendStart);

      if (settled !== null) {
        return {
          status: settled.status === RUN_STATUS.done ? "done" : "stuck",
          turns: turn,
        };
      }

      // Stopped while still red without acting → nudge it to act, not narrate.
      ctx.messages.push({ role: "user", content: NO_TOOL_CALL_NUDGE });
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
