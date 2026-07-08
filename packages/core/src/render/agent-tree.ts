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
    // Key by the subagent's identity (agentId) when present, else `message` —
    // the scheduler's synthetic lifecycle events carry the id in `message`,
    // while a real subagent's `agent_result` puts the payload there, not the id.
    const id = event.agentId ?? event.message;

    if (event.kind === "agent_spawned") {
      statuses.set(id, "pending");
    } else if (event.kind === "agent_started") {
      statuses.set(id, "running");
    } else if (event.kind === "agent_result") {
      statuses.set(id, event.passed === true ? "done" : "failed");
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

/** Below this width a row's fixed prefix (connector + glyph + marker) alone
 *  exceeds `columns - 1`, so no line can be kept within the no-self-wrap budget.
 *  Render nothing rather than emit a line the terminal would wrap (which breaks
 *  the in-place repaint). A real terminal is never this narrow; the guard just
 *  keeps the ≤ columns-1 invariant total. */
const MIN_TREE_COLUMNS = 8;

export interface IAgentTreeOptions {
  /** Terminal width; lines are kept ≤ `columns - 1` so none self-wraps. */
  readonly columns: number;
  /** Spinner frame index (running rows animate as the caller ticks this). */
  readonly frame?: number;
  /** Max rows before overflow collapses; ≥1. */
  readonly maxRows?: number;
  readonly color?: boolean;
  /** Id of the currently-selected row (bold + `▸` marker) when the tree is being
   *  navigated. Absent ⇒ no selection highlight. */
  readonly selectedId?: string;
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

/** Render one child row: connector + status glyph + clipped label + meta. The
 *  label and meta share the width budget; meta is dropped wholesale (never
 *  half-printed) when it can't fit, so the assembled line never exceeds
 *  `columns - 1` (which the terminal would self-wrap, breaking the repaint). */
function rowLine(
  row: IAgentRow,
  isLast: boolean,
  frame: number,
  columns: number,
  color: boolean,
  selected: boolean
): string {
  const connector = isLast ? CONNECT_END : CONNECT_MID;
  const glyph = statusGlyph(row.status, frame);
  // connector + glyph + the single space before the label (+ a `▸` when selected).
  const marker = selected ? "▸" : " ";
  const prefixWidth = displayWidth(connector) + displayWidth(glyph.text) + 1;
  const budget = Math.max(0, columns - 1 - prefixWidth);
  const meta = rowMeta(row);
  const showMeta = meta.length > 0 && displayWidth(meta) <= budget;
  const labelBudget = showMeta ? budget - displayWidth(meta) : budget;
  const label = fitLabel(row.label ?? row.id, labelBudget);
  const painted = selected
    ? paint(label, `${STYLE.bold}${STYLE.brand}`, color)
    : label;

  return (
    paint(connector, STYLE.dim, color) +
    paint(glyph.text, glyph.code, color) +
    `${marker}${painted}` +
    (showMeta ? paint(meta, STYLE.dim, color) : "")
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
 * ≤ `columns - 1` so a terminal never self-wraps one (labels clip, meta drops).
 * The real terminal width is honored — no upward clamp that could draw wider
 * than the screen. A non-positive width falls back to 80. Empty input → `[]`.
 */
export function renderAgentTree(
  rows: readonly IAgentRow[],
  opts: IAgentTreeOptions
): string[] {
  if (rows.length === 0) {
    return [];
  }

  const columns = opts.columns > 0 ? opts.columns : 80;

  if (columns < MIN_TREE_COLUMNS) {
    return [];
  }

  const color = opts.color ?? true;
  const frame = opts.frame ?? 0;
  const maxRows = Math.max(1, opts.maxRows ?? DEFAULT_MAX_ROWS);
  const overflow = rows.length > maxRows;
  const shown = overflow ? rows.slice(0, maxRows - 1) : rows;
  const lines = [headerLine(rows, columns, color)];

  shown.forEach((row, i) => {
    const isLast = !overflow && i === shown.length - 1;

    lines.push(
      rowLine(row, isLast, frame, columns, color, row.id === opts.selectedId)
    );
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

  /** Fold an `agent_spawned`/`agent_started`/`agent_result` lifecycle event.
   *  Rows are keyed by `agentId` (the subagent's identity) when present, falling
   *  back to `message` for the scheduler's synthetic events (which put the id in
   *  `message`). Without this, an `agent_result` whose `message` carries the
   *  final payload — not the id — would spawn a bogus row instead of completing
   *  the running one. On spawn, `message` becomes the row label when `agentId`
   *  already identifies the row. */
  applyEvent(event: ILoopEvent): void {
    const id = event.agentId ?? event.message;

    if (event.kind === "agent_spawned") {
      const label = event.agentId === undefined ? undefined : event.message;

      this.set(id, "pending", label === undefined ? undefined : { label });
    } else if (event.kind === "agent_started") {
      this.set(id, "running");
    } else if (event.kind === "agent_result") {
      this.set(id, event.passed === true ? "done" : "failed");
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
