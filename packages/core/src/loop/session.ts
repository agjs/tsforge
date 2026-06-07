import type { IChatMessage, IModelResponse, IProvider } from "../inference";
import type { ITask } from "../spec";
import type { ErrorParser } from "../validate";
import { LOOP_LIMITS, RUN_STATUS } from "./loop.constants";
import type { Reporter } from "./loop.types";
import { CHAT_SYSTEM, COMPACT_SYSTEM } from "./prompt";
import {
  buildTsService,
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
}

/** The outcome of one `send`. `responded` = conversational (no gate); the gate
 *  verdicts are `done`/`stuck` as in `runTask`; `interrupted` = the user aborted. */
export interface ISendResult {
  status: "responded" | "done" | "stuck" | "interrupted";
  turns: number;
}

const SESSION_ID = "session";

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

    const ctx: ILoopCtx = {
      task,
      cwd: cfg.cwd,
      tsService: await buildTsService(cfg.cwd),
      parse: cfg.parse,
      report: cfg.report ?? ((): void => undefined),
      messages:
        cfg.history !== undefined && cfg.history.length > 0
          ? [...cfg.history]
          : [{ role: "system", content: systemPrompt(cfg) }],
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
  async send(text: string, signal?: AbortSignal): Promise<ISendResult> {
    const { ctx, report } = this;
    const maxTurns = this.cfg.maxTurns ?? LOOP_LIMITS.maxTurns;

    ctx.messages.push({ role: "user", content: text });

    const sendStart = performance.now();

    try {
      return await this.drive(maxTurns, sendStart, signal);
    } catch (err) {
      if (signal?.aborted === true) {
        report({
          kind: "stuck",
          task: SESSION_ID,
          message: "interrupted",
        });

        return { status: "interrupted", turns: 0 };
      }

      throw err;
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
        if (channel === "reasoning") {
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

  private async drive(
    maxTurns: number,
    sendStart: number,
    signal?: AbortSignal
  ): Promise<ISendResult> {
    const { ctx, state, report } = this;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const turnStart = performance.now();

      report({
        kind: "cycle",
        task: SESSION_ID,
        cycle: turn,
        message: `turn ${turn}: asking model`,
      });

      const res = await this.askModel(signal);

      // Still working — run the calls and keep going (we gate only when it stops).
      if (res.toolCalls.length > 0) {
        await runToolCalls(res.toolCalls, ctx, state);
        emitTiming(report, SESSION_ID, turn, turnStart, sendStart);
        continue;
      }

      // The model yielded. No gate ⇒ a plain conversational answer.
      if (!this.hasGate) {
        emitTiming(report, SESSION_ID, turn, turnStart, sendStart);

        return { status: "responded", turns: turn };
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
