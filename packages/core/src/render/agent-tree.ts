/**
 * Agent-tree rendering. Two surfaces grow from the same fold-the-lifecycle model:
 *   - `formatAgentSummary` / `makeAgentSummaryTracker` — a one-line textual
 *     summary (`agents: 2 running, 1/6 done (…)`) for non-TTY / piped output.
 *   - `renderAgentTree` + `AgentTreeModel` — the live multi-row tree (per-child
 *     rows, Claude-Code style) painted above the prompt on a real terminal.
 */
import type { ILoopEvent, Reporter } from "../loop/loop.types";
import type { UnitStatus } from "../agent/agent-scheduler";
import { STYLE, paint } from "./style";
import { displayWidth, sliceToWidth } from "./width";

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
 * A Reporter that folds the agent lifecycle events into a status map and
 * writes one refreshed summary line per transition. All units spawn up-front
 * (pending), so the `k/N done` denominator is stable from the first line.
 * Other event kinds pass through untouched (they belong to whatever reporter
 * the caller composes this with).
 */
export function makeAgentSummaryTracker(
  write: (line: string) => void
): Reporter {
  const statuses = new Map<string, AgentItemStatus>();

  return (event: ILoopEvent): void => {
    if (event.kind === "agent_spawned") {
      statuses.set(event.message, "pending");
    } else if (event.kind === "agent_started") {
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

// --- live multi-row tree -----------------------------------------------------

/** One rendered child row: its label, current status, and (once terminal) the
 *  wall-clock + turn count so a finished row reads `✓ explore · 1.2s · 3 turns`. */
export interface IAgentRow {
  readonly id: string;
  /** Human label; falls back to `id` when absent. */
  readonly label?: string;
  readonly status: AgentItemStatus;
  /** Wall-clock once the row is done/failed. */
  readonly durationMs?: number;
  /** Model turns once the row is done/failed. */
  readonly turns?: number;
}

/** Braille spinner frames for running rows (shared visual language with the
 *  turn spinner in render/spinner.ts). */
const TREE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const CONNECT_MID = "├─ ";
const CONNECT_END = "└─ ";

/** Default cap on rendered rows before the tail collapses to `… +N more`, so a
 *  big fan-out can't push the prompt off a short terminal. */
const DEFAULT_MAX_ROWS = 12;

export interface IAgentTreeOptions {
  /** Terminal width; lines are kept ≤ `columns - 1` so none self-wraps. */
  readonly columns: number;
  /** Spinner frame index (running rows animate as the caller ticks this). */
  readonly frame?: number;
  /** Max rows before overflow collapses; ≥1. */
  readonly maxRows?: number;
  readonly color?: boolean;
}

interface ISegment {
  readonly text: string;
  readonly code: string;
}

/** Glyph + color for a row's status; running rows animate through the spinner. */
function statusGlyph(status: AgentItemStatus, frame: number): ISegment {
  if (status === "running") {
    const i =
      ((frame % TREE_SPINNER_FRAMES.length) + TREE_SPINNER_FRAMES.length) %
      TREE_SPINNER_FRAMES.length;

    return { text: TREE_SPINNER_FRAMES[i] ?? "⠋", code: STYLE.brand };
  }

  if (status === "done") {
    return { text: "✓", code: STYLE.green };
  }

  if (status === "failed") {
    return { text: "✗", code: STYLE.red };
  }

  return { text: "○", code: STYLE.dim };
}

/** Trailing ` · 1.2s · 3 turns` for a terminal row; empty while pending/running. */
function rowMeta(row: IAgentRow): string {
  if (row.status !== "done" && row.status !== "failed") {
    return "";
  }

  const parts: string[] = [];

  if (row.durationMs !== undefined) {
    parts.push(`${(row.durationMs / 1000).toFixed(1)}s`);
  }

  if (row.turns !== undefined) {
    parts.push(`${String(row.turns)} turn${row.turns === 1 ? "" : "s"}`);
  }

  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/** Fit `label` into `avail` columns, appending `…` when it must be clipped. */
function fitLabel(label: string, avail: number): string {
  if (displayWidth(label) <= avail) {
    return label;
  }

  if (avail <= 1) {
    return sliceToWidth(label, avail).text;
  }

  return `${sliceToWidth(label, avail - 1).text}…`;
}

/** Render one child row: connector + status glyph + clipped label + meta. */
function rowLine(
  row: IAgentRow,
  isLast: boolean,
  frame: number,
  columns: number,
  color: boolean
): string {
  const connector = isLast ? CONNECT_END : CONNECT_MID;
  const glyph = statusGlyph(row.status, frame);
  const meta = rowMeta(row);
  const label = row.label ?? row.id;
  const fixed =
    displayWidth(connector) + displayWidth(glyph.text) + 1 + displayWidth(meta);
  const avail = Math.max(0, columns - 1 - fixed);

  return (
    paint(connector, STYLE.dim, color) +
    paint(glyph.text, glyph.code, color) +
    ` ${fitLabel(label, avail)}` +
    paint(meta, STYLE.dim, color)
  );
}

/** The header line: `● agents · 2 running · 1/3 done · 1 failed`. */
function headerLine(
  rows: readonly IAgentRow[],
  columns: number,
  color: boolean
): string {
  const running = rows.filter((r) => r.status === "running").length;
  const done = rows.filter((r) => r.status === "done").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const parts = ["agents"];

  if (running > 0) {
    parts.push(`${String(running)} running`);
  }

  parts.push(`${String(done)}/${String(rows.length)} done`);

  if (failed > 0) {
    parts.push(`${String(failed)} failed`);
  }

  const text = fitLabel(parts.join(" · "), Math.max(0, columns - 3));

  return `${paint("●", STYLE.brand, color)} ${paint(text, STYLE.dim, color)}`;
}

/**
 * Render the live agent tree as an ordered array of terminal lines (header +
 * one row per child, tail-collapsed past `maxRows`). Every line is kept
 * ≤ `columns - 1` so a terminal never self-wraps one. Empty input → `[]`.
 */
export function renderAgentTree(
  rows: readonly IAgentRow[],
  opts: IAgentTreeOptions
): string[] {
  if (rows.length === 0) {
    return [];
  }

  const columns = Math.max(20, opts.columns);
  const color = opts.color ?? true;
  const frame = opts.frame ?? 0;
  const maxRows = Math.max(1, opts.maxRows ?? DEFAULT_MAX_ROWS);
  const overflow = rows.length > maxRows;
  const shown = overflow ? rows.slice(0, maxRows - 1) : rows;
  const lines = [headerLine(rows, columns, color)];

  shown.forEach((row, i) => {
    const isLast = !overflow && i === shown.length - 1;

    lines.push(rowLine(row, isLast, frame, columns, color));
  });

  if (overflow) {
    const hidden = rows.length - shown.length;

    lines.push(paint(`└─ … +${String(hidden)} more`, STYLE.dim, color));
  }

  return lines;
}

/** Map a scheduler unit status onto a tree item status (`start` → running). */
function unitToItem(status: UnitStatus): AgentItemStatus {
  if (status === "start") {
    return "running";
  }

  if (status === "done" || status === "failed") {
    return status;
  }

  return "pending";
}

/** Optional terminal-row metadata (wall-clock + turns), threaded from the
 *  scheduled unit's IAgentResult on the done/failed transition. */
export interface IRowMeta {
  readonly label?: string;
  readonly durationMs?: number;
  readonly turns?: number;
}

/**
 * Folds a fan-out's lifecycle into an ordered set of {@link IAgentRow}s for the
 * live tree. Insertion order (spawn order) is preserved, so pending rows appear
 * up-front and never reshuffle as they run/finish. Fed either from scheduler
 * unit transitions (`applyUnit`, used by `tsforge agents`) or from lifecycle
 * events (`applyEvent`, for the event-driven REPL path).
 */
export class AgentTreeModel {
  private readonly order: string[] = [];
  private readonly byId = new Map<string, IAgentRow>();

  private set(id: string, status: AgentItemStatus, meta?: IRowMeta): void {
    if (!this.byId.has(id)) {
      this.order.push(id);
    }

    const prev = this.byId.get(id);

    this.byId.set(id, {
      id,
      status,
      label: meta?.label ?? prev?.label,
      durationMs: meta?.durationMs ?? prev?.durationMs,
      turns: meta?.turns ?? prev?.turns,
    });
  }

  /** Fold a scheduler unit transition (pending/start/done/failed). */
  applyUnit(id: string, status: UnitStatus, meta?: IRowMeta): void {
    this.set(id, unitToItem(status), meta);
  }

  /** Fold an `agent_spawned`/`agent_started`/`agent_result` lifecycle event. */
  applyEvent(event: ILoopEvent): void {
    if (event.kind === "agent_spawned") {
      this.set(event.message, "pending");
    } else if (event.kind === "agent_started") {
      this.set(event.message, "running");
    } else if (event.kind === "agent_result") {
      this.set(event.message, event.passed === true ? "done" : "failed");
    }
  }

  /** The current rows, in spawn order. */
  rows(): IAgentRow[] {
    const out: IAgentRow[] = [];

    for (const id of this.order) {
      const row = this.byId.get(id);

      if (row !== undefined) {
        out.push(row);
      }
    }

    return out;
  }
}
