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
import { commandGate } from "../gate/gate-runner";
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
import { trace } from "../lib/trace";
import { TOOL_SPECS, TOOL_NAME } from "./agent.constants";
import type { IAgentSpec } from "./agent-spec";
import { buildSalvageDigest, salvageOrFallback } from "./salvage";

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

/** Conservative summarizer-input bound (chars ≈ 4/token → ~12k tokens) used when
 *  the context window is UNKNOWN (window ≤ 0). Small enough to fit any real
 *  model's window + output reserve, so a reactive-recovery compaction can't
 *  itself overflow. */
const FALLBACK_COMPACT_CHARS = 48_000;

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

  // Each joined part also costs a "\n\n" separator — count it, or many short
  // messages slip past `budget` in aggregate.
  const SEP = "\n\n".length;
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
    if (picked.length > 0 && used + text.length + SEP > budget) {
      break;
    }

    picked.unshift(text);
    used += text.length + SEP;
    firstIdx = i;
  }

  const marker =
    firstIdx > 0 ? [`… (${String(firstIdx)} earlier message(s) elided) …`] : [];
  const assembled = [...marker, ...picked].join("\n\n");

  if (assembled.length <= maxChars) {
    return assembled;
  }

  // Only reachable when maxChars < the marker reserve (never in production, where
  // maxChars is window*2). Drop the marker, then hard-cap, so the ≤ maxChars
  // contract holds for ALL inputs.
  const bare = picked.join("\n\n");

  if (bare.length <= maxChars) {
    return bare;
  }

  // Safe slice: .slice() could split a UTF-16 surrogate pair (e.g., emoji).
  // Check if the last char is a high surrogate (0xD800–0xDBFF) and drop it
  // to avoid emitting a malformed character.
  const sliced = bare.slice(0, maxChars);
  const lastCharCode = sliced.charCodeAt(sliced.length - 1);

  return lastCharCode >= 0xd800 && lastCharCode <= 0xdbff
    ? sliced.slice(0, -1)
    : sliced;
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
  // system+transcript+its own output always fit. When the window is UNKNOWN
  // (reactive recovery with no contextWindow), fall back to a conservative fixed
  // bound so the compaction call itself can't overflow — never unbounded.
  const maxChars = window > 0 ? window * 2 : FALLBACK_COMPACT_CHARS;
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

/** Names `agentTools` would advertise for `subset` — used to detect declared
 *  tools this session gates off (e.g. web tools without TSFORGE_WEB). */
function agentToolNames(subset: readonly string[] | undefined): Set<string> {
  return new Set(
    toolsFor(true)
      .map((tool) => tool.function.name)
      .filter(
        (name) =>
          isReadOnlyTool(name) &&
          (subset === undefined || subset.includes(name))
      )
  );
}

export interface IAgentResult {
  status: "done" | "max_turns" | "aborted" | "error";
  /** Final text (or the structured `result` payload). */
  output: string;
  /** How `output` was produced: "answer" = the model wrote it (done, or the
   *  cap-hit finalization call succeeded); "salvage" = a mechanical transcript
   *  digest because no model-written answer exists. Callers use it to label a
   *  non-done result as usable partial findings vs. best-effort scraps. */
  outputKind: "answer" | "salvage";
  turns: number;
  durationMs: number;
  /** Every event the agent emitted, agentId-tagged (for replay/tests). */
  events: ILoopEvent[];
}

/**
 * Cap-hit wrap-up instructions. Injected by the runner (never spec text, so
 * they cannot drift from the real budget) right before the single finalization
 * call that replaces the old behavior of silently discarding the transcript.
 * Exported for tests.
 */
export const AGENT_FINAL_TURN_STRUCTURED =
  "FINAL TURN — your turn budget is exhausted and your investigation tools " +
  "have been removed. Call the agent_result tool NOW with everything you have " +
  "learned so far. Partial findings are fine: report what you verified (with " +
  "the file:line or URL sources you actually saw) and list what remains " +
  "unverified as open questions. Do not describe what you would do next; do " +
  "not ask for more turns.";

export const AGENT_FINAL_TURN_TEXT =
  "FINAL TURN — your turn budget is exhausted and your investigation tools " +
  "have been removed. Answer NOW in plain text with everything you have " +
  "learned so far. Partial findings are fine: report what you verified (with " +
  "the file:line or URL sources you actually saw) and list what remains " +
  "unverified as open questions. Do not describe what you would do next.";

/** Tools advertised only under TSFORGE_WEB — named in the fast-fail hint so a
 *  spawn that lost its whole toolset to the gate says WHY instead of flailing. */
const WEB_GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_NAME.webSearch,
  TOOL_NAME.webFetch,
  TOOL_NAME.webBrowse,
  TOOL_NAME.packageInfo,
  TOOL_NAME.packageDocs,
]);

/** Opening budget line — the agent must know it is on a clock from turn 1. */
function budgetLine(maxTurns: number, structured: boolean): string {
  const finishMove = structured
    ? "call agent_result with your findings"
    : "answer in plain text with your findings";

  return (
    `[budget] You have ${String(maxTurns)} investigation turns. Budget them: ` +
    `finish investigating with 1-2 turns to spare and use the final turn to ` +
    `${finishMove}; report unfinished threads as open questions.`
  );
}

/** Budget countdown: with two turns left, steer from widening to consolidating
 *  — the agent must know the clock is running out BEFORE the axe falls, or it
 *  is mid-investigation on its last turn. Skipped for tiny budgets (<4) where
 *  there is no room to consolidate anyway. */
function maybePushCountdown(
  ctx: ILoopCtx,
  structured: boolean,
  turn: number,
  maxTurns: number
): void {
  if (turn !== maxTurns - 2 || maxTurns < 4) {
    return;
  }

  const finishMove = structured
    ? "finish with agent_result on your final turn"
    : "write your final answer on your final turn";

  ctx.messages.push({
    role: "user",
    content:
      "[budget] 2 turns left — stop opening new threads; consolidate what " +
      `you have and ${finishMove}.`,
  });
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
 *  reads: the `summary` followed by cited `findings`. Guards against undefined/
 *  null/non-object arguments (provider should validate, but we don't crash on
 *  malformed calls). Falls back to legacy `{ result }` string or raw JSON when
 *  the structured shape is absent, so an older spec still yields something usable. */
export function resultPayload(args: unknown): string {
  // Guard before property access — malformed tool args can't cause TypeError.
  if (!isRecord(args)) {
    return typeof args === "string" ? args : JSON.stringify(args ?? {});
  }

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
        outputKind: "answer",
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

    const structured = spec.outputMode === "structured";
    const maxTurns = spec.maxTurns ?? AGENT_LIMITS.maxTurns;
    const tools = structured
      ? [...agentTools(spec.tools), AGENT_RESULT_TOOL]
      : agentTools(spec.tools);

    // Declared-but-gated-off tools: a spec can name tools this session doesn't
    // advertise (web tools without TSFORGE_WEB). Zero resolved → fail fast with
    // the reason instead of burning the whole budget on "call agent_result"
    // nudges; some resolved → tell the agent up front what it is missing so it
    // works with what it has instead of flailing after its declared toolset.
    const declared = spec.tools ?? [];
    const resolvedNames = agentToolNames(spec.tools);
    const missing = declared.filter((name) => !resolvedNames.has(name));
    const webHint =
      missing.length > 0 && missing.every((n) => WEB_GATED_TOOL_NAMES.has(n))
        ? " Web tools require TSFORGE_WEB=1 (on by default only in the interactive REPL) — enable it or use a different specialist."
        : "";

    if (declared.length > 0 && tools.length <= (structured ? 1 : 0)) {
      const output =
        `agent '${spec.id}' has no usable tools in this session: none of its ` +
        `declared tools (${declared.join(", ")}) are available.${webHint}`;

      report({ kind: "tool", task: agentId, message: output });

      return {
        status: "error",
        output,
        outputKind: "answer",
        turns: 0,
        durationMs: 0,
        events,
      };
    }

    const availabilityNote =
      missing.length > 0
        ? `\n\n[harness note] These declared tools are NOT available in this session: ${missing.join(", ")}.${webHint} Work with the tools you have and state the limitation in your result.`
        : "";
    const taskText =
      `${opts.task ?? spec.task ?? ""}\n\n` +
      budgetLine(maxTurns, structured) +
      availabilityNote;
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
      gate: {
        parse: undefined,
        runner: commandGate(
          { id: agentId, accept: "", files: ["**/*"] },
          undefined
        ),
      },
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
      steerLevel: 0,
    };
    const start = performance.now();
    const finish = (
      status: IAgentResult["status"],
      output: string,
      turns: number,
      outputKind: IAgentResult["outputKind"] = "answer"
    ): IAgentResult => ({
      status,
      output,
      outputKind,
      turns,
      durationMs: performance.now() - start,
      events,
    });

    // Shared progress so an abort/error mid-run reports the TRUE turn count
    // and any partial output, not maxTurns + "".
    const progress = { turns: 0, lastText: "" };

    // A terminal path must NEVER hand back an empty output: prefer the model's
    // own prose, else digest the transcript — the findings live in ctx.messages
    // and used to be discarded here (the "subagents fail every time" bug).
    const partial = (): { output: string; kind: IAgentResult["outputKind"] } =>
      progress.lastText.length > 0
        ? { output: progress.lastText, kind: "answer" }
        : { output: salvageOrFallback(ctx.messages), kind: "salvage" };

    try {
      return await this.turnLoop(opts, ctx, state, {
        agentId,
        structured,
        tools,
        maxTurns,
        report,
        finish,
        progress,
        partial,
      });
    } catch (err) {
      // A provider AbortError from a mid-request cancellation is an ABORT,
      // not an agent failure.
      if (opts.signal?.aborted === true) {
        const p = partial();

        return finish("aborted", p.output, progress.turns, p.kind);
      }

      const reason = err instanceof Error ? err.message : String(err);

      report({
        kind: "tool",
        task: agentId,
        message: `agent ${spec.id} failed: ${reason}`,
      });

      // The reason goes INTO the output (it used to live only in the event
      // stream, leaving the orchestrator a bare "[id [error]]").
      const digest = buildSalvageDigest(ctx.messages);

      return finish(
        "error",
        digest.length > 0 ? `${reason}\n\n${digest}` : reason,
        progress.turns,
        "salvage"
      );
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
        turns: number,
        outputKind?: IAgentResult["outputKind"]
      ) => IAgentResult;
      progress: { turns: number; lastText: string };
      partial: () => { output: string; kind: IAgentResult["outputKind"] };
    }
  ): Promise<IAgentResult> {
    const {
      agentId,
      structured,
      tools,
      maxTurns,
      report,
      finish,
      progress,
      partial,
    } = loop;
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
          const p = partial();

          return finish("aborted", p.output, turn - 1, p.kind);
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

        maybePushCountdown(ctx, structured, turn, maxTurns);
      }

      // Out of turns without a `done`: one finalization call (tools stripped)
      // so the agent hands over what it learned instead of the old behavior —
      // discarding the transcript and returning its last stray prose line.
      const fin = await this.finalizeAfterCap(ctx, opts, {
        structured,
        report,
        agentId,
        budget,
        partial,
      });

      return finish("max_turns", fin.output, maxTurns, fin.kind);
    }
  }

  /** The cap-hit wrap-up: ONE extra model call with investigation tools
   *  removed (structured: only agent_result, required; text: no tools), asking
   *  for everything learned so far. Any failure — prior abort, provider throw,
   *  or an answerless response — degrades to the mechanical salvage digest;
   *  this path never raises and never returns empty. */
  private async finalizeAfterCap(
    ctx: ILoopCtx,
    opts: IAgentRunOptions,
    args: {
      structured: boolean;
      report: Reporter;
      agentId: string;
      budget: { lastPromptTokens: number };
      partial: () => { output: string; kind: IAgentResult["outputKind"] };
    }
  ): Promise<{ output: string; kind: IAgentResult["outputKind"] }> {
    const { structured, report, agentId, budget, partial } = args;

    if (opts.signal?.aborted === true) {
      return partial();
    }

    report({
      kind: "tool",
      task: agentId,
      message: "⌛ turn budget exhausted — requesting final summary",
    });
    ctx.messages.push({
      role: "user",
      content: structured ? AGENT_FINAL_TURN_STRUCTURED : AGENT_FINAL_TURN_TEXT,
    });

    try {
      const res = await this.completeWithCompaction(
        ctx,
        opts,
        {
          tools: structured ? [AGENT_RESULT_TOOL] : [],
          ...(structured ? { toolChoice: "required" as const } : {}),
          temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          onToken: (text) => {
            report({ kind: "token", task: agentId, message: text });
          },
        },
        budget,
        report
      );

      const resultCall = res.toolCalls.find(
        (c) => c.name === AGENT_RESULT_TOOL.function.name
      );

      if (resultCall !== undefined) {
        return { output: resultPayload(resultCall.arguments), kind: "answer" };
      }

      if (res.content.trim().length > 0) {
        return { output: res.content, kind: "answer" };
      }
    } catch (err) {
      // Salvage below — a failed wrap-up must not convert a cap into an error.
      trace("agentRunner.finalizeAfterCap", err);
    }

    return { output: salvageOrFallback(ctx.messages), kind: "salvage" };
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
