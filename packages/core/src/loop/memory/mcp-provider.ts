import { isRecord } from "../../lib/guards";
import { mcpToolName } from "../../mcp";
import type { IMcpMemoryProviderConfig } from "../../config/memory-provider.types";
import { redactForRetain } from "./redact";
import { formatDecisionBrief } from "./format-brief";
import {
  DECISION_RECALL_QUERY,
  MEMORY_REQUEST_TIMEOUT_MS,
  type IMemoryProvider,
} from "./provider.types";
import { withDeadline } from "./deadline";

export interface IMcpToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

function parseListPayload(raw: string): readonly string[] {
  const trimmed = raw.trim();

  if (
    trimmed.length === 0 ||
    trimmed.startsWith("unknown MCP") ||
    trimmed.startsWith("MCP tool")
  ) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);

    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }

    if (isRecord(parsed) && typeof parsed.text === "string") {
      return parsed.text.trim().length > 0 ? [parsed.text.trim()] : [];
    }
  } catch {
    // fall through — treat as one blob
  }

  return [trimmed];
}

/** Bound an MCP tool call so list/forget can't hang the slash command forever. */
async function callBounded(
  caller: IMcpToolCaller,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  return withDeadline(
    caller.callTool(name, args),
    "MCP tool timed out",
    MEMORY_REQUEST_TIMEOUT_MS
  );
}

export function createMcpMemoryProvider(
  bankId: string,
  config: IMcpMemoryProviderConfig,
  caller: IMcpToolCaller
): IMemoryProvider {
  const retainTool = mcpToolName(config.server, config.retainTool ?? "retain");
  const recallTool = mcpToolName(config.server, config.recallTool ?? "recall");
  const forgetTool = mcpToolName(config.server, config.forgetTool ?? "forget");
  const listTool =
    config.listTool !== undefined
      ? mcpToolName(config.server, config.listTool)
      : null;

  return {
    bankId,

    async recall(query: string): Promise<string | null> {
      const raw = await callBounded(caller, recallTool, {
        bank_id: bankId,
        query: query.length > 0 ? query : DECISION_RECALL_QUERY,
      });

      if (
        raw.startsWith("unknown MCP") ||
        raw.startsWith("MCP tool") ||
        raw === "MCP tool timed out"
      ) {
        throw new Error(raw);
      }

      try {
        const parsed: unknown = JSON.parse(raw);

        if (isRecord(parsed) && typeof parsed.text === "string") {
          return formatDecisionBrief(parsed.text);
        }
      } catch {
        // plain text
      }

      return formatDecisionBrief(raw);
    },

    async retain(content: string): Promise<boolean> {
      const redacted = redactForRetain(content);

      if (redacted.length === 0) {
        return true;
      }

      try {
        const raw = await callBounded(caller, retainTool, {
          bank_id: bankId,
          content: redacted,
        });

        if (
          raw.startsWith("unknown MCP") ||
          raw.startsWith("MCP tool") ||
          raw === "MCP tool timed out"
        ) {
          return false;
        }

        return true;
      } catch {
        return false;
      }
    },

    async list(): Promise<readonly string[]> {
      if (listTool === null) {
        return [];
      }

      try {
        const raw = await callBounded(caller, listTool, { bank_id: bankId });

        if (raw === "MCP tool timed out") {
          return [];
        }

        return parseListPayload(raw);
      } catch {
        return [];
      }
    },

    async forget(): Promise<void> {
      try {
        await callBounded(caller, forgetTool, { bank_id: bankId });
      } catch {
        // fail-soft
      }
    },
  };
}
