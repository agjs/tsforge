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
import type { IProvider } from "../inference";
import type { ILoopEvent, Reporter } from "../loop/loop.types";
import {
  buildTsService,
  runToolCalls,
  toolsFor,
  type ILoopCtx,
  type ILoopState,
} from "../loop/turn";
import { TOOL_SPECS } from "./agent.constants";
import type { IAgentSpec } from "./agent-spec";

export const AGENT_LIMITS = {
  /** Default turn cap for a subagent — exploration, not an open-ended session. */
  maxTurns: 12,
} as const;

const DEFAULT_SYSTEM = [
  "You are a focused read-only investigator inside a coding harness.",
  "Explore the workspace with the provided tools, then answer the task in ONE",
  "final message: state conclusions with file:line references, not raw dumps.",
  "You cannot edit files — do not propose tool calls that write.",
].join(" ");

/** The structured-output control tool: intercepted by the runner itself (never
 *  dispatched to executeTool), so the parent gets a parseable final payload. */
const AGENT_RESULT_TOOL = {
  type: "function",
  function: {
    name: "agent_result",
    description:
      "Return your final result and finish. Call exactly once, when done.",
    parameters: {
      type: "object",
      properties: {
        result: {
          type: "string",
          description: "Your complete findings/answer.",
        },
      },
      required: ["result"],
    },
  },
} as const;

/** Cast-free read-only check against the TOOL_SPECS registry. */
function isReadOnlyTool(name: string): boolean {
  return Object.entries(TOOL_SPECS).some(
    ([tool, spec]) => tool === name && spec.readOnly
  );
}

/** The agent's advertised tools: read-only set ∩ optional spec subset. */
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
}

/** Pull the structured payload out of an intercepted agent_result call. */
function resultPayload(args: Record<string, unknown>): string {
  return typeof args.result === "string" ? args.result : JSON.stringify(args);
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
      opts.report?.(tagged);
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
      tsService: await buildTsService(opts.cwd),
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

    try {
      return await this.turnLoop(opts, ctx, state, {
        agentId,
        structured,
        tools,
        maxTurns,
        report,
        finish,
      });
    } catch (err) {
      report({
        kind: "tool",
        task: agentId,
        message: `agent ${spec.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      });

      return finish("error", "", maxTurns);
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
    }
  ): Promise<IAgentResult> {
    const { agentId, structured, tools, maxTurns, report, finish } = loop;
    let lastText = "";

    {
      for (let turn = 1; turn <= maxTurns; turn += 1) {
        if (opts.signal?.aborted === true) {
          return finish("aborted", lastText, turn - 1);
        }

        report({
          kind: "cycle",
          task: agentId,
          cycle: turn,
          message: `agent ${this.spec.id} · turn ${turn}`,
        });

        const res = await opts.provider.complete(ctx.messages, {
          tools,
          toolChoice: "auto",
          temperature: opts.temperature ?? 0,
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          onToken: (text) => {
            report({ kind: "token", task: agentId, message: text });
          },
        });

        ctx.messages.push({
          role: "assistant",
          content: res.content,
          toolCalls: res.toolCalls,
          ...(res.reasoning === undefined
            ? {}
            : { reasoningContent: res.reasoning }),
        });
        lastText = res.content.length > 0 ? res.content : lastText;

        const resultCall = res.toolCalls.find(
          (c) => c.name === AGENT_RESULT_TOOL.function.name
        );

        if (resultCall !== undefined) {
          return finish("done", resultPayload(resultCall.arguments), turn);
        }

        if (res.toolCalls.length === 0) {
          // A structured agent that just stops talking has NOT delivered its
          // payload — nudge once per remaining turn rather than accept prose.
          if (structured) {
            ctx.messages.push({
              role: "user",
              content:
                "Call the agent_result tool with your final result to finish.",
            });
            continue;
          }

          return finish("done", res.content, turn);
        }

        await runToolCalls(res.toolCalls, ctx, state);
      }

      return finish("max_turns", lastText, maxTurns);
    }
  }
}
