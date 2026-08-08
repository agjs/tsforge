import { paint } from "../style";
import { fitAnsiLine } from "./fit-line";
import { CONSOLE } from "./chrome";

/** Scroll position for a vertical track (grok-build ScrollInfo shape). */
export interface IScrollMetrics {
  /** Wrapped content rows. */
  readonly total: number;
  /** Visible rows in the track. */
  readonly viewport: number;
  /** Rows from the top of the content (0 = showing the oldest). */
  readonly offset: number;
  /** Stick-to-bottom live mode. */
  readonly following: boolean;
}

const THUMB = "█";

/** Content overflows the viewport — show the track. */
export function needsScrollbar(metrics: IScrollMetrics): boolean {
  return metrics.total > metrics.viewport && metrics.viewport > 0;
}

/**
 * Inclusive-exclusive `[start, end)` thumb window on a `track`-tall column.
 * Proportional to viewport/total; pinned to the bottom while following.
 */
export function thumbWindow(
  metrics: IScrollMetrics,
  track: number
): { start: number; end: number } | null {
  if (!needsScrollbar(metrics) || track <= 0) {
    return null;
  }

  const thumbLen = Math.min(
    track,
    Math.max(1, Math.round((metrics.viewport / metrics.total) * track))
  );
  const travel = track - thumbLen;
  const maxOffset = Math.max(1, metrics.total - metrics.viewport);
  const offset = metrics.following
    ? maxOffset
    : Math.max(0, Math.min(metrics.offset, maxOffset));
  const start = travel === 0 ? 0 : Math.round((offset / maxOffset) * travel);

  return { start, end: start + thumbLen };
}

/**
 * One painted cell per track row: dim/bright `█` thumb over blank track.
 * Following → muted thumb (content is live); scrolled-up → brighter.
 */
export function formatScrollbarColumn(
  metrics: IScrollMetrics,
  track: number,
  color = true
): string[] | null {
  const win = thumbWindow(metrics, track);

  if (win === null) {
    return null;
  }

  const thumbStyle = metrics.following ? CONSOLE.muted : CONSOLE.bright;
  const thumb = paint(THUMB, thumbStyle, color);
  const cells: string[] = [];

  for (let r = 0; r < track; r += 1) {
    cells.push(r >= win.start && r < win.end ? thumb : " ");
  }

  return cells;
}

/**
 * Replace the rightmost column of a main-pane line with a scrollbar cell.
 * Uses the existing right inset pad so wrap width stays unchanged.
 * Fast path: `insetX` pads with trailing spaces — drop one and append.
 */
export function overlayScrollbarCol(
  line: string,
  cols: number,
  cell: string
): string {
  if (cols <= 1) {
    return cell;
  }

  if (line.endsWith(" ")) {
    return `${line.slice(0, -1)}${cell}`;
  }

  return `${fitAnsiLine(line, cols - 1)}${cell}`;
}
