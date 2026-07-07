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
 *  one turn honors `agents.concurrency` instead of hammering the endpoint. */
function makeLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: (() => void)[] = [];

  const release = (): void => {
    active -= 1;
    queue.shift()?.();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
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
 *  reads — tagged with the specialist and (only when not clean) its status. */
function formatResult(id: string, result: IAgentResult): string {
  const tag = result.status === "done" ? id : `${id} [${result.status}]`;

  return `[${tag}]\n${result.output}`;
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
        });

        lifecycle("agent_result", result.status === "done");

        return formatResult(spec.id, result);
      } catch (err) {
        lifecycle("agent_result", false);

        const message = err instanceof Error ? err.message : String(err);

        return `[${spec.id} [error]]\n${message}`;
      }
    });
  };
}
