import type { Reporter } from "../loop.types";
import type { IMcpToolCaller } from "./mcp-provider";
import type { IMemoryProvider } from "./provider.types";
import type { IMemoryProviderConfig } from "../../config/memory-provider.types";
import { createMemoryProvider } from "./create-provider";
import { DECISION_RECALL_QUERY } from "./provider.types";
import { trace } from "../../lib/trace";

export interface IDecisionMemoryLoad {
  readonly provider: IMemoryProvider | null;
  readonly brief: string | null;
}

/**
 * Opt-in decision memory at session start. Fail-soft: errors → null provider/brief.
 */
export async function loadDecisionMemoryAtStart(
  cwd: string,
  config: IMemoryProviderConfig | undefined,
  mcpCaller: IMcpToolCaller | null,
  report: Reporter,
  taskId: string
): Promise<IDecisionMemoryLoad> {
  try {
    const provider = await createMemoryProvider(cwd, config, mcpCaller);

    if (provider === null) {
      return { provider: null, brief: null };
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

    return { provider: null, brief: null };
  }
}
