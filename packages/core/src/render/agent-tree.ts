/**
 * Agent-tree rendering, Phase A slice: a one-line textual summary of a
 * fan-out's progress (`agents: 2 running, 1 done (find:a.ts · find:b.ts)`).
 * The full live tree (per-child rows above the input row, Claude-Code style)
 * lands in Phase B and grows out of this module.
 */
import type { ILoopEvent, Reporter } from "../loop/loop.types";

export type AgentItemStatus = "pending" | "running" | "done" | "failed";

export interface IAgentSummaryItem {
  readonly id: string;
  readonly status: AgentItemStatus;
}

/** How many running-agent ids to list before eliding the rest. */
const MAX_LISTED = 3;

function countOf(
  items: readonly IAgentSummaryItem[],
  status: AgentItemStatus
): number {
  return items.filter((i) => i.status === status).length;
}

/** One-line progress summary for a set of fan-out units. Empty input → "". */
export function formatAgentSummary(
  items: readonly IAgentSummaryItem[]
): string {
  if (items.length === 0) {
    return "";
  }

  const running = items.filter((i) => i.status === "running");
  const parts: string[] = [];
  const done = countOf(items, "done");
  const failed = countOf(items, "failed");

  if (running.length > 0) {
    parts.push(`${running.length} running`);
  }

  parts.push(`${done}/${items.length} done`);

  if (failed > 0) {
    parts.push(`${failed} failed`);
  }

  const listed = running.slice(0, MAX_LISTED).map((i) => i.id);
  const extra = running.length - listed.length;
  const tail =
    listed.length > 0
      ? ` (${listed.join(" · ")}${extra > 0 ? ` · +${extra}` : ""})`
      : "";

  return `agents: ${parts.join(", ")}${tail}`;
}

/**
 * A Reporter that folds `agent_spawned`/`agent_result` events into a running
 * status map and writes one refreshed summary line per transition. All other
 * event kinds pass through untouched (they belong to whatever reporter the
 * caller composes this with).
 */
export function makeAgentSummaryTracker(
  write: (line: string) => void
): Reporter {
  const statuses = new Map<string, AgentItemStatus>();

  return (event: ILoopEvent): void => {
    if (event.kind === "agent_spawned") {
      statuses.set(event.message, "running");
    } else if (event.kind === "agent_result") {
      statuses.set(event.message, event.passed === true ? "done" : "failed");
    } else {
      return;
    }

    const items = [...statuses.entries()].map(([id, status]) => ({
      id,
      status,
    }));

    write(formatAgentSummary(items));
  };
}
