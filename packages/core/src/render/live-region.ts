/**
 * A block of lines pinned to the bottom of the terminal and repainted in place
 * (log-update style): each `render` climbs to the block's top, `ESC[0J`-erases
 * to end of screen, and redraws. Scrollback above the block is never touched.
 *
 * Unlike {@link StatusBar} it owns no input/editor/bar state — just N status
 * lines — so it is the minimal live surface for one-shot fan-out output (the
 * `tsforge agents` tree). On a non-TTY sink every call is a no-op, so piped and
 * `--log` runs fall back to the caller's plain-text path unchanged.
 */
import { displayWidth } from "./width";
import { stripSgr } from "./frame/ansi-plain";

const ESC = "\x1b";

/** The minimal sink LiveRegion needs — matches `process.stdout` but injectable
 *  so a VirtualScreen test can capture the exact byte stream. `columns` lets the
 *  erase account for soft-wrapped lines (a line wider than the terminal occupies
 *  more than one physical row). */
export interface ILiveRegionOut {
  write(data: string): boolean;
  readonly isTTY?: boolean;
  readonly columns?: number;
}

/** Physical terminal rows `lines` occupy at width `cols`: each logical line
 *  soft-wraps to ceil(displayWidth/cols) rows (min 1 — a blank line is one row).
 *  SGR is stripped first so color codes aren't counted as columns. `cols <= 0`
 *  (width unknown) falls back to one row per line — no worse than the old
 *  logical-line assumption. */
function physicalRows(lines: readonly string[], cols: number): number {
  if (cols <= 0) {
    return lines.length;
  }

  let total = 0;

  for (const line of lines) {
    total += Math.max(1, Math.ceil(displayWidth(stripSgr(line)) / cols));
  }

  return total;
}

export class LiveRegion {
  /** Terminal rows the block currently occupies (0 = nothing drawn yet). */
  private rows = 0;

  constructor(
    private readonly out: ILiveRegionOut,
    private readonly enabled = true
  ) {}

  private get active(): boolean {
    return this.enabled && this.out.isTTY === true;
  }

  /** Move the cursor from the bottom of the current block to its top and erase
   *  it. Assumes the cursor is parked at the end of the last drawn line (where
   *  the previous render left it). When nothing is drawn yet (`rows === 0`) this
   *  is empty: there is no block of ours to erase, and emitting `\r ESC[0J`
   *  would clobber whatever the caller just printed on the current line. */
  private eraseCurrent(): string {
    if (this.rows === 0) {
      return "";
    }

    if (this.rows > 1) {
      return `${ESC}[${String(this.rows - 1)}A\r${ESC}[0J`;
    }

    return `\r${ESC}[0J`;
  }

  /** Repaint the block with `lines`. Empty `lines` clears it. */
  render(lines: readonly string[]): void {
    if (!this.active) {
      return;
    }

    if (lines.length === 0) {
      this.clear();

      return;
    }

    // Raw-mode terminals are ONLCR-off; joining with CRLF renders correctly in
    // both raw and cooked sinks (a cooked terminal collapses the extra CR). A
    // trailing RESET closes any unbalanced SGR so a colored line can't bleed
    // into the scrollback above the block.
    this.out.write(this.eraseCurrent() + lines.join("\r\n") + `${ESC}[0m`);
    // Track PHYSICAL rows, not logical lines: a line wider than the terminal
    // wraps to several rows, and the next erase must climb ALL of them or it
    // leaves ghost fragments of the previous block above the redraw.
    this.rows = physicalRows(lines, this.out.columns ?? 0);
  }

  /** Erase the block and leave the cursor at its former top line. Idempotent. */
  clear(): void {
    if (!this.active || this.rows === 0) {
      return;
    }

    this.out.write(this.eraseCurrent());
    this.rows = 0;
  }
}
