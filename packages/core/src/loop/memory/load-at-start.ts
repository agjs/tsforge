import type { Reporter } from "../loop.types";
import type { IMcpToolCaller } from "./mcp-provider";
import type { IMemoryProvider } from "./provider.types";
import type { IMemoryProviderConfig } from "../../config/memory-provider.types";
import { createMemoryProvider } from "./create-provider";
import {
  DECISION_RECALL_QUERY,
  MEMORY_START_TIMEOUT_MS,
} from "./provider.types";
import { withDeadlineResult } from "./deadline";
import { trace } from "../../lib/trace";

export { withDeadline, withDeadlineResult } from "./deadline";

export interface IDecisionMemoryLoad {
  readonly provider: IMemoryProvider | null;
  readonly brief: string | null;
}

export interface IDecisionMemoryLoadDeps {
  readonly createProvider?: (
    cwd: string,
    config: IMemoryProviderConfig | undefined,
    mcpCaller: IMcpToolCaller | null
  ) => Promise<IMemoryProvider | null>;
  /** Override start-up ceiling (tests). */
  readonly startTimeoutMs?: number;
}

/**
 * Opt-in decision memory at session start.
 *
 * Create + recall share ONE start-up budget. Create may use most of it; recall
 * gets whatever remains (never a rigid 50/50 split that rejects in-budget init).
 * A slow/failed recall must not discard the provider; empty ≠ backend failure.
 */
export async function loadDecisionMemoryAtStart(
  cwd: string,
  config: IMemoryProviderConfig | undefined,
  mcpCaller: IMcpToolCaller | null,
  report: Reporter,
  taskId: string,
  deps: IDecisionMemoryLoadDeps = {}
): Promise<IDecisionMemoryLoad> {
  const empty: IDecisionMemoryLoad = { provider: null, brief: null };

  if (config === undefined) {
    return empty;
  }

  const create = deps.createProvider ?? createMemoryProvider;
  const budget = deps.startTimeoutMs ?? MEMORY_START_TIMEOUT_MS;
  const started = Date.now();

  try {
    const created = await withDeadlineResult(
      create(cwd, config, mcpCaller),
      budget
    );

    if (created.timedOut || created.value === null) {
      return empty;
    }

    const provider = created.value;
    const remaining = Math.max(1, budget - (Date.now() - started));

    try {
      const recalled = await withDeadlineResult(
        provider.recall(DECISION_RECALL_QUERY),
        remaining
      );

      if (recalled.timedOut) {
        report({
          kind: "tool",
          task: taskId,
          message: `decision memory: bank ${provider.bankId} ready (recall timed out)`,
        });

        return { provider, brief: null };
      }

      const brief = recalled.value;

      if (brief !== null) {
        report({
          kind: "tool",
          task: taskId,
          message: `decision memory: loaded brief for bank ${provider.bankId}`,
        });
      } else {
        report({
          kind: "tool",
          task: taskId,
          message: `decision memory: bank ${provider.bankId} ready (empty)`,
        });
      }

      return { provider, brief };
    } catch (err) {
      // Backend/transport failure — keep the write path; don't call it "empty".
      trace("session.decision-memory", err);
      report({
        kind: "tool",
        task: taskId,
        message: `decision memory: bank ${provider.bankId} ready (recall failed)`,
      });

      return { provider, brief: null };
    }
  } catch (err) {
    trace("session.decision-memory", err);

    return empty;
  }
}
