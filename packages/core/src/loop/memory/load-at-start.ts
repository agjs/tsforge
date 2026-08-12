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
 * Resolve `work`, or mark timed out when it has not settled within `ms`.
 */
export async function withDeadlineResult<T>(
  work: Promise<T>,
  ms: number
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      trace("session.decision-memory", `timed out after ${ms}ms`);
      resolve({ timedOut: true });
    }, ms);
  });

  try {
    return await Promise.race([
      work.then((value) => ({ timedOut: false as const, value })),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve `work`, or `fallback` when it has not settled within `ms`.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  fallback: T,
  ms: number = MEMORY_START_TIMEOUT_MS
): Promise<T> {
  const result = await withDeadlineResult(work, ms);

  return result.timedOut ? fallback : result.value;
}

/**
 * Opt-in decision memory at session start.
 *
 * Create + recall share ONE start-up budget (not 2×). A slow recall must not
 * discard the provider; timeouts are announced distinctly from empty banks.
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
  const createBudget = Math.max(1, Math.floor(budget / 2));
  const recallBudget = Math.max(1, budget - createBudget);

  try {
    const created = await withDeadlineResult(
      create(cwd, config, mcpCaller),
      createBudget
    );

    if (created.timedOut || created.value === null) {
      return empty;
    }

    const provider = created.value;
    const recalled = await withDeadlineResult(
      provider.recall(DECISION_RECALL_QUERY),
      recallBudget
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
    trace("session.decision-memory", err);

    return empty;
  }
}
