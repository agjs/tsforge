import type { Reporter } from "../loop.types";
import type { IMcpToolCaller } from "./mcp-provider";
import type { IMemoryProvider } from "./provider.types";
import type { IMemoryProviderConfig } from "../../config/memory-provider.types";
import { createMemoryProvider } from "./create-provider";
import {
  DECISION_RECALL_QUERY,
  MEMORY_START_TIMEOUT_MS,
} from "./provider.types";
import { trace } from "../../lib/trace";

export interface IDecisionMemoryLoad {
  readonly provider: IMemoryProvider | null;
  readonly brief: string | null;
}

/**
 * Resolve `work`, or `fallback` when it has not settled within `ms`.
 *
 * The session cannot start until this returns, so a memory backend must never
 * be able to block it. The HTTP provider carries its own per-request deadline;
 * this additionally bounds provider construction and the MCP transport, which
 * has no abort plumbing of its own.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  fallback: T,
  ms: number = MEMORY_START_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      trace("session.decision-memory", `timed out after ${ms}ms`);
      resolve(fallback);
    }, ms);
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    // Without this the pending timer keeps the event loop alive and delays exit.
    clearTimeout(timer);
  }
}

/**
 * Opt-in decision memory at session start. Fail-soft: errors, and now also a
 * backend that simply never answers, → null provider/brief.
 */
export async function loadDecisionMemoryAtStart(
  cwd: string,
  config: IMemoryProviderConfig | undefined,
  mcpCaller: IMcpToolCaller | null,
  report: Reporter,
  taskId: string
): Promise<IDecisionMemoryLoad> {
  const empty: IDecisionMemoryLoad = { provider: null, brief: null };

  const load = async (): Promise<IDecisionMemoryLoad> => {
    try {
      const provider = await createMemoryProvider(cwd, config, mcpCaller);

      if (provider === null) {
        return empty;
      }

      const brief = await provider.recall(DECISION_RECALL_QUERY);

      if (brief !== null) {
        report({
          kind: "tool",
          task: taskId,
          message: `decision memory: loaded brief for bank ${provider.bankId}`,
        });
      }

      return { provider, brief };
    } catch (err) {
      trace("session.decision-memory", err);

      return empty;
    }
  };

  return withDeadline(load(), empty);
}
