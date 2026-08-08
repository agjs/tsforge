import { wrapAnsiLines } from "./wrap-line";
import type { IScrollMetrics } from "./scrollbar";

/** Width-stable bookmark for the viewport top (Grok ScrollAnchor idea). */
export interface IScrollAnchor {
  /** Index into logical (unwrapped) lines. */
  readonly logicalIndex: number;
  /** Wrapped-row offset within that logical line. */
  readonly offsetInEntry: number;
}

/**
 * Line ring buffer + viewport for the main pane. Newest lines append at the end;
 * the viewport shows a window that sticks to the bottom unless the user scrolls up.
 *
 * Logical lines are wrapped to the pane width at viewport time so resize reflows
 * and scroll never "loses" the tail of a truncated row.
 *
 * Wrapped rows are cached — recomputing wrap over thousands of transcript lines
 * on every keystroke (via PaneScreen.paint) was multi‑tens-of-ms of lag.
 */
export class Scrollback {
  private lines: string[] = [];
  /** Incomplete trailing line (not yet terminated by `\n`). */
  private partial = "";
  private offsetFromBottom = 0;
  private wrapCols = 80;
  /** Invalidated on append / clear / wrap-width change. */
  private cachedWrapped: string[] | null = null;
  /** Overflow flag from the last following viewport walk (`view` keyed). */
  private followingOverflow = false;
  private followingOverflowView = -1;

  constructor(
    private readonly capacity = 5_000,
    private viewportRows = 1
  ) {}

  setViewportRows(rows: number): void {
    const next = Math.max(1, rows);

    if (next !== this.viewportRows) {
      this.followingOverflowView = -1;
    }

    this.viewportRows = next;
    this.clampOffset();
  }

  /** Column width used when wrapping logical lines into the viewport. */
  setWrapCols(cols: number): void {
    const next = Math.max(1, cols);

    if (next === this.wrapCols) {
      this.clampOffset();

      return;
    }

    this.wrapCols = next;
    this.invalidateWrap();
    this.clampOffset();
  }

  /**
   * Change wrap width; when scrolled up, re-pin via anchor so the same logical
   * line stays at the viewport top.
   */
  reflow(cols: number): void {
    const following = this.offsetFromBottom === 0;
    const anchor = following ? null : this.captureAnchor();
    const next = Math.max(1, cols);

    if (next !== this.wrapCols) {
      this.wrapCols = next;
      this.invalidateWrap();
    }

    if (anchor !== null) {
      this.restoreAnchor(anchor);
    } else {
      this.offsetFromBottom = 0;
      this.clampOffset();
    }
  }

  /** Append text, splitting on newlines. Bare `\r` is ignored. */
  append(text: string): void {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "");

    if (normalized.length === 0) {
      return;
    }

    const combined = this.partial + normalized;
    const parts = combined.split("\n");

    this.partial = parts.pop() ?? "";

    for (const line of parts) {
      this.lines.push(line);
    }

    let trimmed = false;

    while (this.lines.length > this.capacity) {
      this.lines.shift();
      trimmed = true;
    }

    this.invalidateWrap();

    // Following (offset 0) never needs a wrap pass to clamp. Rebuilding the
    // wrap cache on every streamed line was O(n²) and made typing after a long
    // transcript feel like molasses once paint touched scrollback.
    if (trimmed || this.offsetFromBottom > 0) {
      this.clampOffset();
    }
  }

  /** Scroll by delta wrapped rows (positive = older / up; negative = newer / down). */
  scroll(delta: number): void {
    this.offsetFromBottom = Math.max(0, this.offsetFromBottom + delta);
    this.clampOffset();
  }

  /** Jump to the newest content. */
  follow(): void {
    this.offsetFromBottom = 0;
  }

  /** Drop all buffered lines (e.g. `/clear` in the pane TUI). */
  clear(): void {
    this.lines = [];
    this.partial = "";
    this.offsetFromBottom = 0;
    this.invalidateWrap();
  }

  get following(): boolean {
    return this.offsetFromBottom === 0;
  }

  /**
   * Metrics for the main-pane scrollbar.
   * Following + overflow avoids a full wrap of the transcript (thumb sits at
   * the bottom); scrolled-up reuses the wrap cache already built by `visible()`.
   */
  metrics(): IScrollMetrics {
    const viewport = this.viewportRows;

    if (this.offsetFromBottom === 0) {
      const overflow = this.hasOverflowFollowing(viewport);

      return {
        total: overflow ? viewport + 1 : viewport,
        viewport,
        offset: overflow ? viewport : 0,
        following: true,
      };
    }

    const total = this.wrapped().length;
    const maxOffset = Math.max(0, total - viewport);

    return {
      total,
      viewport,
      offset: Math.max(0, maxOffset - this.offsetFromBottom),
      following: false,
    };
  }

  /** All complete lines plus the current partial, for viewport/dump. */
  private allLines(): string[] {
    if (this.partial.length === 0) {
      return this.lines;
    }

    return [...this.lines, this.partial];
  }

  private invalidateWrap(): void {
    this.cachedWrapped = null;
    this.followingOverflowView = -1;
  }

  private wrapped(): string[] {
    if (this.cachedWrapped === null) {
      this.cachedWrapped = wrapAnsiLines(this.allLines(), this.wrapCols);
    }

    return this.cachedWrapped;
  }

  /**
   * Map each wrapped row to its logical line index and offset within that line.
   */
  private wrapMap(): { rows: string[]; owners: IScrollAnchor[] } {
    const logical = this.allLines();
    const rows: string[] = [];
    const owners: IScrollAnchor[] = [];

    for (let i = 0; i < logical.length; i += 1) {
      const parts = wrapAnsiLines([logical[i] ?? ""], this.wrapCols);

      for (let o = 0; o < parts.length; o += 1) {
        rows.push(parts[o] ?? "");
        owners.push({ logicalIndex: i, offsetInEntry: o });
      }
    }

    return { rows, owners };
  }

  /** Visible wrapped rows for the current viewport (top → bottom). */
  visible(): string[] {
    const view = this.viewportRows;

    // Hot path: stick-to-bottom. Walk logical lines from the tail so a long
    // transcript never pays for wrapping the entire buffer on every paint.
    if (this.offsetFromBottom === 0) {
      return this.visibleFollowing(view);
    }

    const all = this.wrapped();
    const end = all.length - this.offsetFromBottom;
    const start = Math.max(0, end - view);
    const slice = all.slice(start, end);

    while (slice.length < view) {
      slice.unshift("");
    }

    return slice;
  }

  /** Bottom-following viewport — O(viewport) wraps, not O(transcript). */
  private visibleFollowing(view: number): string[] {
    const logical = this.allLines();
    const collected: string[] = [];
    let moreAbove = false;

    for (let i = logical.length - 1; i >= 0; i -= 1) {
      const parts = wrapAnsiLines([logical[i] ?? ""], this.wrapCols);

      for (let j = parts.length - 1; j >= 0; j -= 1) {
        if (collected.length >= view) {
          moreAbove = true;
          i = -1;
          break;
        }

        collected.unshift(parts[j] ?? "");
      }
    }

    this.followingOverflow = moreAbove;
    this.followingOverflowView = view;

    // Short content: top-align (pad below) so the landing isn't a void above.
    if (!moreAbove) {
      while (collected.length < view) {
        collected.push("");
      }

      return collected;
    }

    while (collected.length < view) {
      collected.unshift("");
    }

    return collected;
  }

  /**
   * True when following and there are wrapped rows above the viewport.
   * Reuses the flag from `visibleFollowing` when that walk already ran for
   * the same view (compose calls `visible()` before `metrics()`).
   */
  private hasOverflowFollowing(view: number): boolean {
    if (this.followingOverflowView === view) {
      return this.followingOverflow;
    }

    const logical = this.allLines();
    let count = 0;

    for (let i = logical.length - 1; i >= 0; i -= 1) {
      const parts = wrapAnsiLines([logical[i] ?? ""], this.wrapCols);

      count += parts.length;

      if (count > view) {
        this.followingOverflow = true;
        this.followingOverflowView = view;

        return true;
      }
    }

    this.followingOverflow = false;
    this.followingOverflowView = view;

    return false;
  }

  /** Capture anchor for the current viewport top when scrolled up. */
  captureAnchor(): IScrollAnchor | null {
    if (this.offsetFromBottom === 0) {
      return null;
    }

    const { rows, owners } = this.wrapMap();
    const end = rows.length - this.offsetFromBottom;
    const start = Math.max(0, end - this.viewportRows);
    const owner = owners[start];

    return owner ?? null;
  }

  /** Restore viewport so `anchor` sits at the top after a wrap-width change. */
  restoreAnchor(anchor: IScrollAnchor): void {
    const { rows, owners } = this.wrapMap();
    let top = 0;

    for (let i = 0; i < owners.length; i += 1) {
      const o = owners[i];

      if (
        o?.logicalIndex === anchor.logicalIndex &&
        o.offsetInEntry === anchor.offsetInEntry
      ) {
        top = i;
        break;
      }

      if (
        o?.logicalIndex === anchor.logicalIndex &&
        o.offsetInEntry > anchor.offsetInEntry
      ) {
        top = i;
        break;
      }
    }

    const end = Math.min(rows.length, top + this.viewportRows);

    this.offsetFromBottom = Math.max(0, rows.length - end);
    this.clampOffset();
  }

  /** Full transcript for dump-to-scrollback (logical lines, not wrapped). */
  dump(): string {
    return this.allLines().join("\n");
  }

  get length(): number {
    return this.allLines().length;
  }

  private clampOffset(): void {
    if (this.offsetFromBottom === 0) {
      return;
    }

    const maxOffset = Math.max(0, this.wrapped().length - this.viewportRows);

    if (this.offsetFromBottom > maxOffset) {
      this.offsetFromBottom = maxOffset;
    }
  }
}
