/**
 * AgentRunner — the read-only subagent loop. Composes the turn primitives
 * directly (provider.complete + runToolCalls), NOT runTask: runTask is an
 * edit-to-green loop (RED precheck, gate-driving, full toolset) and a
 * read-only explorer has nothing to gate. Read-only is STRUCTURAL here:
 * (1) advertised tools are the spec subset ∩ TOOL_SPECS read-only set,
 * (2) ctx.tool.readOnly=true makes executeTool hard-reject any mutation,
 * (3) the policy layer still evaluates first, as for every tool call.
 * Lifecycle events (agent_spawned/started/result) belong to the ORCHESTRATOR
 * (scheduler unitReporter); the runner only tags its inner events with
 * agentId/parentTask so interleaved streams stay attributable.
 */
import type { IProvider, IModelResponse } from "../inference";
import type { TsService } from "../lsp";
import type { PolicyMode, IPolicyRules } from "../policy";
import type { ILoopEvent, Reporter } from "../loop/loop.types";
import {
  buildTsService,
  runToolCalls,
  toolsFor,
  type ILoopCtx,
  type ILoopState,
} from "../loop/turn";
import { DEFAULT_TEMPERATURE } from "../loop/loop.constants";
import { PROVIDER_LIMITS } from "../inference";
import { COMPACT_SYSTEM } from "../loop/prompt";
import { isRecord } from "../lib/guards";
import { TOOL_SPECS } from "./agent.constants";
import type { IAgentSpec } from "./agent-spec";

export const AGENT_LIMITS = {
  /** Default turn cap for a subagent — exploration, not an open-ended session. */
  maxTurns: 12,
  /** Compact the conversation once the server-reported prompt tokens reach this
   *  fraction of the context window — mirrors the main loop's auto-compaction
   *  (session.ts). Without it a subagent's history grows unbounded (every re-read
   *  re-appends the whole file) until the request overflows the window and the
   *  endpoint 400s — so exploration could FAIL for no reason other than length. */
  autoCompactAt: 0.8,
} as const;

/** Best-effort human-readable message from an unknown throw. Handles the common
 *  provider shapes without casts: an Error, or a plain object carrying `message`
 *  (or a nested `error.message`, as some HTTP clients surface API errors). */
function errorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  if (isRecord(err)) {
    if (typeof err.message === "string") {
      return err.message;
    }

    if (isRecord(err.error) && typeof err.error.message === "string") {
      return err.error.message;
    }
  }

  return String(err);
}

/** A vLLM/OpenAI-style context-overflow rejection ("This model's maximum context
 *  length is N tokens. However, you requested M…"). Matched so it can be RECOVERED
 *  (compact + retry) instead of failing the agent. Exported for unit tests. */
export function isContextOverflow(err: unknown): boolean {
  return /maximum context length|context length|context window|too many tokens|reduce the length|too long/iu.test(
    errorText(err)
  );
}

/** Chars reserved for the elision marker + join separators, so the assembled
 *  transcript stays within `maxChars` even after they're added. */
const TRANSCRIPT_MARKER_RESERVE = 64;

/** Join the conversation (system excluded) into a summarizer prompt bounded to
 *  `maxChars` so the compaction request itself can never overflow the window.
 *  Fills from the MOST RECENT message backward (recent context matters most and
 *  is the reason for the overflow) and ALWAYS includes at least the newest
 *  message — head-truncating it if it alone exceeds the budget — then walks back
 *  through older turns while they fit, eliding the rest. maxChars ≤ 0 ⇒ unbounded.
 *  Exported for unit tests. */
export function buildBoundedTranscript(
  conversation: readonly { role: string; content?: string }[],
  maxChars: number
): string {
  const line = (m: { role: string; content?: string }): string =>
    `[${m.role}] ${m.content ?? ""}`;

  if (maxChars <= 0 || conversation.length === 0) {
    return conversation.map(line).join("\n\n");
  }

  // No single message may exceed the budget — truncate an oversized one so it
  // can still be included (the newest is often a giant tool result).
  const budget = Math.max(1, maxChars - TRANSCRIPT_MARKER_RESERVE);

  const capped = (m: { role: string; content?: string }): string => {
    const text = line(m);

    return text.length <= budget
      ? text
      : `${text.slice(0, Math.max(1, budget - 15))} …[truncated]`;
  };

  const picked: string[] = [];
  let used = 0;
  let firstIdx = conversation.length;

  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    const msg = conversation[i];

    if (msg === undefined) {
      continue;
    }

    const text = capped(msg);

    // Always keep at least the newest (picked is empty on the first iteration).
    if (picked.length > 0 && used + text.length > budget) {
      break;
    }

    picked.unshift(text);
    used += text.length;
    firstIdx = i;
  }

  const marker =
    firstIdx > 0 ? [`… (${String(firstIdx)} earlier message(s) elided) …`] : [];

  return [...marker, ...picked].join("\n\n");
}

/** Summarize the conversation and REPLACE it with [system, summary] — the same
 *  shape the main loop's Session.compact uses — freeing context while preserving
 *  the task, findings, and decisions. The summarizer input is bounded to a safe
 *  fraction of the window so this call itself can't overflow. */
async function compactAgentMessages(
  ctx: ILoopCtx,
  provider: IProvider,
  window: number,
  signal?: AbortSignal
): Promise<boolean> {
  const conversation = ctx.messages.filter((m) => m.role !== "system");

  if (conversation.length === 0) {
    return false;
  }

  // ~4 chars/token; give the summarizer at most half the window of input so
  // system+transcript+its own output always fit.
  const maxChars = window > 0 ? window * 2 : 0;
  const transcript = buildBoundedTranscript(conversation, maxChars);
  const res = await provider.complete(
    [
      { role: "system", content: COMPACT_SYSTEM },
      { role: "user", content: transcript },
    ],
    { temperature: 0, ...(signal === undefined ? {} : { signal }) }
  );

  const system = ctx.messages[0];
  const summary = {
    role: "user" as const,
    content: `[Summary of the investigation so far]\n${res.content}`,
  };

  ctx.messages = system?.role === "system" ? [system, summary] : [summary];

  return true;
}

const DEFAULT_SYSTEM = [
  "You are a focused read-only investigator inside a coding harness.",
  "You do NOT know the codebase — you MUST investigate before answering.",
  "Use the tools (search/read/symbol_search/…) to open the actual files the",
  "task is about; NEVER answer from memory or guess. Read real code first,",
  "then answer in ONE final message: concrete conclusions, each backed by a",
  "`file:line` reference you actually saw. An answer with no file:line",
  "citations means you did not investigate and is wrong.",
  "You cannot edit files — do not propose tool calls that write.",
].join(" ");

/** The structured-output control tool: intercepted by the runner itself (never
 *  dispatched to executeTool), so the parent gets a PARSEABLE final payload —
 *  a headline `summary` plus a list of concrete `findings`, each carrying its
 *  own `source` (`file:line` for code, a URL for external docs). Forcing this
 *  shape both keeps output consistent for the orchestrator and pushes the model
 *  to attach evidence to every point instead of emitting uncited prose. */
const AGENT_RESULT_TOOL = {
  type: "function",
  function: {
    name: "agent_result",
    description:
      "Return your final result and finish. Call exactly once, when done. Put the " +
      "headline conclusion (or verdict) in `summary`, and each concrete point in " +
      "`findings` — every code point MUST carry the `file:line` you saw in `source`.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "1–3 sentence headline conclusion or verdict.",
        },
        findings: {
          type: "array",
          description:
            "The concrete points; empty only if there is genuinely none.",
          items: {
            type: "object",
            properties: {
              detail: {
                type: "string",
                description: "One specific observation, issue, or fact.",
              },
              source: {
                type: "string",
                description:
                  "Where you saw it: `path/to/file.ts:123` for code, or a URL for external docs.",
              },
              confidence: {
                type: "string",
                enum: ["high", "medium", "low"],
                description: "How sure you are of this point.",
              },
            },
            required: ["detail"],
          },
        },
      },
      required: ["summary", "findings"],
    },
  },
} as const;

/** Read-only tool names, computed once from the registry (O(1) lookups,
 *  no casts). */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.entries(TOOL_SPECS)
    .filter(([, spec]) => spec.readOnly)
    .map(([name]) => name)
);

function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(name);
}

/** The agent's advertised tools: read-only set ∩ optional spec subset.
 *  `spawn_agent` is NOT among them — it is never part of `toolsFor()` (the CLI
 *  adds it only to the orchestrator's list), so a subagent structurally cannot
 *  delegate and recursion depth is capped at 1. */
function agentTools(subset: readonly string[] | undefined): unknown[] {
  return toolsFor(true).filter((tool) => {
    const name = tool.function.name;

    return (
      isReadOnlyTool(name) && (subset === undefined || subset.includes(name))
    );
  });
}

export interface IAgentResult {
  status: "done" | "max_turns" | "aborted" | "error";
  /** Final text (or the structured `result` payload). */
  output: string;
  turns: number;
  durationMs: number;
  /** Every event the agent emitted, agentId-tagged (for replay/tests). */
  events: ILoopEvent[];
}

export interface IAgentRunOptions {
  provider: IProvider;
  cwd: string;
  /** The spawning task's id — the agent's id becomes `${parentTaskId}:${spec.id}`. */
  parentTaskId: string;
  /** The task text; falls back to spec.task. */
  task?: string;
  report?: Reporter;
  signal?: AbortSignal;
  temperature?: number;
  /** Project policy — subagents obey the SAME deny/allow/ask rules as the
   *  parent session; omitting these must be a caller decision, not a leak. */
  policyMode?: PolicyMode;
  policyRules?: IPolicyRules;
  /** Reuse the parent's TsService — building one per concurrent agent is
   *  heavy. `null` = workspace has none; undefined = build our own. */
  tsService?: TsService | null;
  /** The model's context window (tokens). When set, the runner auto-compacts its
   *  conversation before a request would overflow it — so a long investigation
   *  (many/large reads) never fails on length. Omitted ⇒ no compaction. */
  contextWindow?: number;
}

/** Render one structured finding as `- detail (source) [confidence]`. */
function formatFinding(f: unknown): string | null {
  if (!isRecord(f) || typeof f.detail !== "string" || f.detail.length === 0) {
    return null;
  }

  const source =
    typeof f.source === "string" && f.source.length > 0 ? ` (${f.source})` : "";
  const confidence =
    typeof f.confidence === "string" ? ` [${f.confidence}]` : "";

  return `- ${f.detail}${source}${confidence}`;
}

/** Flatten an intercepted `agent_result` call into the text the orchestrator
 *  reads: the `summary` followed by cited `findings`. Falls back to the legacy
 *  `{ result }` string or raw JSON if the structured shape is absent, so an
 *  older spec or a malformed call still yields something usable. */
function resultPayload(args: Record<string, unknown>): string {
  const summary = typeof args.summary === "string" ? args.summary : "";
  const findings = Array.isArray(args.findings) ? args.findings : [];
  const lines = findings
    .map(formatFinding)
    .filter((l): l is string => l !== null);

  if (summary.length === 0 && lines.length === 0) {
    return typeof args.result === "string" ? args.result : JSON.stringify(args);
  }

  return [summary, ...lines].filter((s) => s.length > 0).join("\n");
}

/** Force the first move (`"required"`) while real tools exist and nothing has
 *  been investigated yet — this is what stops a local model from answering from
 *  memory in one turn. Once it has read something, or on the last turn (where a
 *  forced call it can't act on is useless), fall back to `"auto"`. */
function nextToolChoice(
  hasRealTools: boolean,
  hasInvestigated: boolean,
  turn: number,
  maxTurns: number
): "required" | "auto" {
  const mustInvestigate = hasRealTools && !hasInvestigated && turn < maxTurns;

  return mustInvestigate ? "required" : "auto";
}

/** Append the model's turn (content + tool calls, replaying reasoning for the
 *  deepseek style) to the conversation. */
function pushAssistant(ctx: ILoopCtx, res: IModelResponse): void {
  ctx.messages.push({
    role: "assistant",
    content: res.content,
    toolCalls: res.toolCalls,
    ...(res.reasoning === undefined ? {} : { reasoningContent: res.reasoning }),
  });
}

export class AgentRunner {
  constructor(private readonly spec: IAgentSpec) {}

  async run(opts: IAgentRunOptions): Promise<IAgentResult> {
    const spec = this.spec;

    if (spec.kind === "generate") {
      return {
        status: "error",
        output: `agent '${spec.id}': kind "generate" is not implemented yet`,
        turns: 0,
        durationMs: 0,
        events: [],
      };
    }

    const agentId = `${opts.parentTaskId}:${spec.id}`;
    const events: ILoopEvent[] = [];

    const report: Reporter = (event) => {
      const tagged: ILoopEvent = {
        ...event,
        agentId,
        parentTask: opts.parentTaskId,
      };

      events.push(tagged);

      try {
        opts.report?.(tagged);
      } catch {
        // A caller's reporter throwing must never kill the agent run.
      }
    };

    const taskText = opts.task ?? spec.task ?? "";
    const structured = spec.outputMode === "structured";
    const tools = structured
      ? [...agentTools(spec.tools), AGENT_RESULT_TOOL]
      : agentTools(spec.tools);
    const ctx: ILoopCtx = {
      // No gate for a read-only agent: accept is empty (never run), and the
      // whole-repo "scope" only matters to write paths executeTool rejects.
      task: { id: agentId, accept: "", files: ["**/*"] },
      cwd: opts.cwd,
      tsService:
        opts.tsService !== undefined
          ? opts.tsService
          : await buildTsService(opts.cwd),
      report,
      messages: [
        { role: "system", content: spec.systemPrompt ?? DEFAULT_SYSTEM },
        { role: "user", content: taskText },
      ],
      // readOnly is NOT taken from the spec — Phase B/C agents cannot mutate,
      // full stop; the write path arrives with Phase D worktree writers.
      tool: {
        touched: new Set<string>(),
        readOnly: true,
        ...(opts.policyMode === undefined
          ? {}
          : { policyMode: opts.policyMode }),
        ...(opts.policyRules === undefined
          ? {}
          : { policyRules: opts.policyRules }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      },
      gate: { parse: undefined },
    };
    const state: ILoopState = {
      prevGateErrors: [],
      gateNoProgress: 0,
      bestErrorCount: Number.POSITIVE_INFINITY,
      noNewLow: 0,
      errorAge: new Map(),
      lastGateCount: -1,
      edits: 0,
      regressions: 0,
      ttsrInterrupts: 0,
    };
    const maxTurns = spec.maxTurns ?? AGENT_LIMITS.maxTurns;
    const start = performance.now();
    const finish = (
      status: IAgentResult["status"],
      output: string,
      turns: number
    ): IAgentResult => ({
      status,
      output,
      turns,
      durationMs: performance.now() - start,
      events,
    });

    // Shared progress so an abort/error mid-run reports the TRUE turn count
    // and any partial output, not maxTurns + "".
    const progress = { turns: 0, lastText: "" };

    try {
      return await this.turnLoop(opts, ctx, state, {
        agentId,
        structured,
        tools,
        maxTurns,
        report,
        finish,
        progress,
      });
    } catch (err) {
      // A provider AbortError from a mid-request cancellation is an ABORT,
      // not an agent failure.
      if (opts.signal?.aborted === true) {
        return finish("aborted", progress.lastText, progress.turns);
      }

      report({
        kind: "tool",
        task: agentId,
        message: `agent ${spec.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      });

      return finish("error", progress.lastText, progress.turns);
    }
  }

  /** The model↔tools turn loop, split from run() to keep complexity in check. */
  private async turnLoop(
    opts: IAgentRunOptions,
    ctx: ILoopCtx,
    state: ILoopState,
    loop: {
      agentId: string;
      structured: boolean;
      tools: unknown[];
      maxTurns: number;
      report: Reporter;
      finish: (
        status: IAgentResult["status"],
        output: string,
        turns: number
      ) => IAgentResult;
      progress: { turns: number; lastText: string };
    }
  ): Promise<IAgentResult> {
    const { agentId, structured, tools, maxTurns, report, finish, progress } =
      loop;
    let lastText = "";
    // Whether the agent has called ANY investigative tool yet. Until it has, we
    // force a tool call (toolChoice "required") instead of letting the model
    // answer from memory in one turn — the adoption failure that made read-only
    // agents return uncited, empty prose. Once it has actually read something,
    // switch to "auto" so it can produce its final answer.
    let hasInvestigated = false;
    const hasRealTools = tools.length > (structured ? 1 : 0);
    // Server-reported prompt tokens from the previous turn — the trigger for
    // proactive compaction (mirrors the main loop, which reads its lastUsage).
    const budget = { lastPromptTokens: 0 };

    {
      for (let turn = 1; turn <= maxTurns; turn += 1) {
        if (opts.signal?.aborted === true) {
          return finish("aborted", lastText, turn - 1);
        }

        progress.turns = turn;

        report({
          kind: "cycle",
          task: agentId,
          cycle: turn,
          message: `agent ${this.spec.id} · turn ${turn}`,
        });

        const res = await this.completeWithCompaction(
          ctx,
          opts,
          {
            tools,
            toolChoice: nextToolChoice(
              hasRealTools,
              hasInvestigated,
              turn,
              maxTurns
            ),
            // Match the main loop's default (0.2), NOT greedy: temperature 0 makes
            // this model early-stop into empty/one-line answers on a long
            // tool-result context. A caller can still override.
            temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
            ...(opts.signal === undefined ? {} : { signal: opts.signal }),
            onToken: (text) => {
              report({ kind: "token", task: agentId, message: text });
            },
          },
          budget,
          report
        );

        pushAssistant(ctx, res);
        lastText = res.content.length > 0 ? res.content : lastText;
        progress.lastText = lastText;

        const resultCall = res.toolCalls.find(
          (c) => c.name === AGENT_RESULT_TOOL.function.name
        );
        const investigativeCalls = res.toolCalls.filter(
          (c) => c.name !== AGENT_RESULT_TOOL.function.name
        );

        // Run any REAL tool calls first — that is what counts as investigation,
        // and it must happen before we'd accept a result emitted in the same turn.
        if (investigativeCalls.length > 0) {
          hasInvestigated = true;
          await runToolCalls(investigativeCalls, ctx, state);
        }

        // Accept a structured result ONLY after real investigation (or when the
        // agent has no real tools to investigate with, e.g. `tools: []`).
        // Otherwise `agent_result` on its own satisfies toolChoice:"required",
        // letting a structured agent answer from memory on turn 1 — reject it and
        // force a real tool call next.
        if (resultCall !== undefined) {
          if (hasInvestigated || !hasRealTools) {
            return finish("done", resultPayload(resultCall.arguments), turn);
          }

          ctx.messages.push({
            role: "tool",
            toolCallId: resultCall.id ?? AGENT_RESULT_TOOL.function.name,
            content:
              "Investigate FIRST: use the tools to read the relevant files, then " +
              "call agent_result with findings backed by file:line. Don't answer " +
              "before looking.",
          });

          continue;
        }

        if (res.toolCalls.length === 0) {
          const done = this.finalizeOrNudge(
            res.content,
            structured,
            hasInvestigated,
            ctx,
            () => finish("done", res.content, turn)
          );

          if (done !== null) {
            return done;
          }
        }
      }

      return finish("max_turns", lastText, maxTurns);
    }
  }

  /** Decide what to do with a no-tool-call response: return a `done` result, or
   *  `null` after pushing a follow-up nudge so the loop takes another turn. A
   *  structured agent must still call `agent_result`; an empty answer with no
   *  investigation is not accepted. */
  private finalizeOrNudge(
    content: string,
    structured: boolean,
    hasInvestigated: boolean,
    ctx: ILoopCtx,
    done: () => IAgentResult
  ): IAgentResult | null {
    if (structured) {
      ctx.messages.push({
        role: "user",
        content: "Call the agent_result tool with your final result to finish.",
      });

      return null;
    }

    if (content.trim().length === 0 && !hasInvestigated) {
      ctx.messages.push({
        role: "user",
        content:
          "You haven't investigated yet. Use the tools to read the relevant files, then answer with file:line citations.",
      });

      return null;
    }

    return done();
  }

  /** Run one model turn with context management around it:
   *  - PROACTIVE: compact before the request when the previous turn's prompt
   *    tokens crossed the auto-compact fraction of the window.
   *  - REACTIVE: if the request still overflows (e.g. one giant tool result
   *    jumped past the threshold in a single turn), compact and retry ONCE —
   *    so a read-only investigation never hard-fails on length.
   *  Updates `budget.lastPromptTokens` from the server's usage. */
  private async completeWithCompaction(
    ctx: ILoopCtx,
    opts: IAgentRunOptions,
    callOpts: Parameters<IProvider["complete"]>[1],
    budget: { lastPromptTokens: number },
    report: Reporter
  ): Promise<IModelResponse> {
    const window = opts.contextWindow ?? 0;
    const provider = opts.provider;
    // vLLM counts prompt + reserved OUTPUT tokens against the window, so the
    // real ceiling for the PROMPT is `window - maxTokens`. Trigger compaction
    // against that effective budget — otherwise a request can 400 while the
    // prompt alone is still under `window` (observed: 114689 prompt + 16384 out
    // = 131073 > 131072). The reserve is CAPPED at half the window so a small
    // model (window ≤ maxTokens) can't collapse the effective budget to ~0 and
    // compact on every single turn. The reactive path below is the backstop for
    // a single read that jumps past the threshold in one turn.
    const reserve = Math.min(
      PROVIDER_LIMITS.maxTokens,
      Math.floor(window * 0.5)
    );
    const effectiveWindow = Math.max(1, window - reserve);
    const at = AGENT_LIMITS.autoCompactAt;

    const compact = async (reason: string): Promise<void> => {
      const did = await compactAgentMessages(
        ctx,
        provider,
        window,
        opts.signal
      );

      if (did) {
        budget.lastPromptTokens = 0;
        report({
          kind: "tool",
          task: `${opts.parentTaskId}:${this.spec.id}`,
          message: `↯ compacted context (${reason})`,
        });
      }
    };

    if (window > 0 && budget.lastPromptTokens / effectiveWindow >= at) {
      await compact(`near ${String(window)}-token window`);
    }

    let res: IModelResponse;

    try {
      res = await provider.complete(ctx.messages, callOpts);
    } catch (err) {
      if (
        opts.signal?.aborted === true ||
        !isContextOverflow(err) ||
        ctx.messages.length <= 2
      ) {
        throw err;
      }

      await compact("recovering from a context-overflow");
      res = await provider.complete(ctx.messages, callOpts);
    }

    budget.lastPromptTokens =
      res.usage?.promptTokens ?? budget.lastPromptTokens;

    return res;
  }
}
