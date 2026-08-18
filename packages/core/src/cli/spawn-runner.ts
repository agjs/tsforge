/**
 * Builds the `spawn_agent` runner callback the interactive session wires in
 * (`session.setDelegation`). This is the CLI-side half of delegation: it owns
 * model resolution, a fresh provider per child, the read-only AgentRunner, the
 * concurrency limiter, and the agent-tree lifecycle events. The tool handler
 * (`loop/tools/spawn-agent.ts`) only validates args and calls this.
 */
import { AgentRunner, type IAgentResult } from "../agent";
import { findAgentSpec } from "../config/agent-specs";
import type { IAgentSpec } from "../agent/agent-spec";
import type { PolicyMode, IPolicyRules } from "../policy";
import type { TsService } from "../lsp";
import type { SpawnAgentFn } from "../loop/tools";
import { resolveModelByName } from "../models-config";
import { makeProvider } from "./model-setup";

/** A minimal async semaphore: at most `max` `run()` bodies execute at once; the
 *  rest queue. Caps concurrent subagents so a burst of `spawn_agent` calls in
 *  one turn honors `agents.concurrency` instead of hammering the endpoint.
 *  Exported for a direct concurrency-cap test. */
export function makeLimiter(
  max: number
): <T>(fn: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: (() => void)[] = [];

  const release = (): void => {
    active -= 1;
    queue.shift()?.();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // Re-check after every wake: a newcomer arriving between release() and the
    // woken waiter's microtask can take the freed slot first — without the
    // loop, both would run and the cap would be transiently exceeded.
    while (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }

    active += 1;

    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/** Compact the child's outcome into the tool-result string the orchestrator
 *  reads — tagged with the specialist and (only when not clean) its status.
 *  A non-done tag says what FOLLOWS (partial findings vs. transcript digest),
 *  so the orchestrator treats capped-but-productive output as usable data
 *  instead of a bare failure. The status word stays the first token inside the
 *  bracket — log tooling keyed on `[max_turns` keeps matching. Exported so the
 *  eval scripts reuse it instead of drifting on a re-implementation. */
export function formatResult(id: string, result: IAgentResult): string {
  if (result.status === "done") {
    return `[${id}]\n${result.output}`;
  }

  const answer = result.outputKind === "answer";
  const detail =
    result.status === "max_turns"
      ? answer
        ? "max_turns — partial findings below"
        : "max_turns — no final answer; transcript digest below"
      : result.status === "aborted"
        ? answer
          ? "aborted — partial output below"
          : "aborted — transcript digest below"
        : "error";

  return `[${id} [${detail}]]\n${result.output}`;
}

export interface ISpawnRunnerOptions {
  readonly specs: readonly IAgentSpec[];
  readonly cwd: string;
  readonly concurrency: number;
  readonly policyMode: PolicyMode;
  readonly policyRules?: IPolicyRules;
  /** Model for agents whose spec doesn't pin one; undefined ⇒ the active model
   *  (so every agent uses the session's model unless a spec overrides it). */
  readonly defaultModel?: string;
  /** Returns the session's TsService (or null) so each child REUSES it instead of
   *  building its own — read lazily (a getter, not a value) so it tracks the
   *  current session across `/clear`. Absent ⇒ the child builds its own. */
  readonly getTsService?: () => TsService | null;
  /** The model's context window (tokens). Threaded to each AgentRunner so it
   *  auto-compacts before a request would overflow — a long investigation never
   *  fails on length. Omitted ⇒ no compaction. */
  readonly contextWindow?: number;
}

export function makeSpawnAgentFn(opts: ISpawnRunnerOptions): SpawnAgentFn {
  const limit = makeLimiter(opts.concurrency);

  return async (req, { signal, report }): Promise<string> => {
    const spec = findAgentSpec(opts.specs, req.subagentType);

    if (spec === undefined) {
      return `spawn_agent: unknown subagent_type "${req.subagentType}"`;
    }

    const agentId = `${req.parentTaskId}:${spec.id}`;

    const lifecycle = (
      kind: "agent_spawned" | "agent_started" | "agent_result",
      passed?: boolean
    ): void => {
      report({
        kind,
        task: req.parentTaskId,
        agentId,
        message: req.description,
        ...(passed === undefined ? {} : { passed }),
      });
    };

    // Announced immediately (a pending tree row) even while it waits for a slot.
    lifecycle("agent_spawned");

    return limit(async () => {
      if (signal?.aborted === true) {
        lifecycle("agent_result", false);

        return `[${spec.id} [aborted]]\n(cancelled before start)`;
      }

      lifecycle("agent_started");

      try {
        const modelName = spec.model ?? opts.defaultModel;
        const { entry } = await resolveModelByName(modelName);
        const result = await new AgentRunner(spec).run({
          provider: makeProvider(entry),
          cwd: opts.cwd,
          parentTaskId: req.parentTaskId,
          task: req.prompt,
          report,
          ...(signal === undefined ? {} : { signal }),
          policyMode: opts.policyMode,
          ...(opts.policyRules === undefined
            ? {}
            : { policyRules: opts.policyRules }),
          ...(opts.getTsService === undefined
            ? {}
            : { tsService: opts.getTsService() }),
          ...(opts.contextWindow === undefined
            ? {}
            : { contextWindow: opts.contextWindow }),
        });

        // ✓ means "findings delivered": done, or a cap-hit whose finalization
        // produced a real answer. ✗ is reserved for salvage/error/abort — the
        // tree should answer "did delegation work?", and the [max_turns] tag in
        // the tool text keeps the budget-health signal visible in logs.
        lifecycle(
          "agent_result",
          result.status === "done" ||
            (result.status === "max_turns" && result.outputKind === "answer")
        );

        return formatResult(spec.id, result);
      } catch (err) {
        lifecycle("agent_result", false);

        const message = err instanceof Error ? err.message : String(err);

        return `[${spec.id} [error]]\n${message}`;
      }
    });
  };
}
