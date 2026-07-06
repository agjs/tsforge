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
const ESC = "\x1b";

/** The minimal sink LiveRegion needs — matches `process.stdout` but injectable
 *  so a VirtualScreen test can capture the exact byte stream. */
export interface ILiveRegionOut {
  write(data: string): boolean;
  readonly isTTY?: boolean;
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
   *  the previous render left it). No-op prefix when nothing is drawn yet. */
  private eraseCurrent(): string {
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
    // both raw and cooked sinks (a cooked terminal collapses the extra CR).
    this.out.write(this.eraseCurrent() + lines.join("\r\n"));
    this.rows = lines.length;
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
