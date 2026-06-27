import type { IStatusInfo } from "./render.types";
import { STYLE, paint } from "./style";

const ESC = "\x1b";

/** Rows reserved at the bottom: a top border rule + the segments line. */
const RESERVED_ROWS = 2;

/** Below this height, a 2-row bar would crowd the conversation — fall back to inline. */
export const MIN_ROWS = 5;

/** Reset all SGR attributes — written after a stream chunk so the input row below
 *  it is never painted in leftover color from mid-stream markdown. */
const RESET_SGR = `${ESC}[0m`;

/** The editable input prompt and the columns it occupies (`›` + space). */
const PROMPT = "› ";
const PROMPT_COLS = 2;

/** Cells in the context meter. */
const METER_CELLS = 9;

/** The minimal terminal surface the bar needs — matches `process.stdout` but is
 *  injectable so the controller is testable without a real TTY. */
export interface IStatusBarTerminal {
  readonly isTTY?: boolean;
  readonly rows?: number;
  readonly columns?: number;
  write(data: string): boolean;
}

/** A bar segment: visible text plus the ANSI color code to paint it with. */
interface ISegment {
  readonly text: string;
  readonly code: string;
}

/** Compact seconds/minutes for the elapsed segment. */
function humanSeconds(ms: number): string {
  const total = Math.round(ms / 1000);

  return total < 60
    ? `${total}s`
    : `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

/** The context-usage meter, colored green / amber / red by fill. */
function meterSegment(info: IStatusInfo): ISegment {
  const pct =
    info.contextWindow > 0
      ? Math.round((info.contextTokens / info.contextWindow) * 100)
      : 0;
  const filled = Math.max(
    0,
    Math.min(METER_CELLS, Math.round((pct / 100) * METER_CELLS))
  );
  const code = pct >= 90 ? STYLE.red : pct >= 70 ? STYLE.yellow : STYLE.green;

  return {
    text: `▕${"█".repeat(filled)}${"░".repeat(METER_CELLS - filled)}▏ ${pct}%`,
    code,
  };
}

/** Glyph + color for the run outcome. */
function statusSegment(status: string): ISegment {
  if (status === "ready" || status === "done" || status === "responded") {
    return { text: `✓ ${status}`, code: STYLE.green };
  }

  if (status === "stuck") {
    return { text: `✗ ${status}`, code: STYLE.red };
  }

  return { text: `● ${status}`, code: STYLE.yellow };
}

/** The ordered segments shown on the bar (model, meter, tok/s, turns, status, scope). */
function barSegments(info: IStatusInfo): ISegment[] {
  const segs: ISegment[] = [{ text: info.model, code: STYLE.brand }];

  // The live "thinking · 12s" spinner rides HERE while a turn runs — it used to
  // animate on the readline input line and erase whatever the user was typing.
  if (info.activity !== undefined && info.activity.length > 0) {
    segs.push({ text: info.activity, code: STYLE.dim });
  }

  segs.push(meterSegment(info));

  if (info.tokensPerSecond !== undefined && info.tokensPerSecond > 0) {
    segs.push({
      text: `⚡ ${info.tokensPerSecond} tok/s`,
      code: STYLE.brandLight,
    });
  }

  if (info.turns > 0) {
    segs.push({
      text: `↻ ${info.turns}·${humanSeconds(info.elapsedMs)}`,
      code: STYLE.dim,
    });
  }

  segs.push(statusSegment(info.status));
  segs.push({ text: info.scope, code: STYLE.dim });

  return segs;
}

/** Join segments left-to-right within `columns`, dropping whole segments that
 *  don't fit (never cuts mid-escape). Returns the painted line. */
function assemble(segs: ISegment[], columns: number, color: boolean): string {
  const sep = "  ";
  let painted = "";
  let width = 1; // leading space

  for (const seg of segs) {
    const add = (painted.length > 0 ? sep.length : 0) + seg.text.length;

    if (width + add > columns) {
      break;
    }

    painted +=
      (painted.length > 0 ? sep : "") + paint(seg.text, seg.code, color);
    width += add;
  }

  return ` ${painted}`;
}

/** A dim rule with a leading corner tick, spanning the width. */
function topBorder(columns: number, color: boolean): string {
  return paint(`╶${"─".repeat(Math.max(0, columns - 3))}`, STYLE.dim, color);
}

/**
 * The two painted bar rows (border + segments) at the bottom, positioned
 * ABSOLUTELY with no cursor save/restore. Callers decide cursor handling: the
 * no-input bar wraps this in save/restore (`buildBarFrame`); the input-row mode
 * re-parks the cursor on the input row itself afterwards.
 */
function buildBarBody(
  info: IStatusInfo,
  columns: number,
  rows: number,
  color: boolean
): string {
  // Clamp to row 1 so a terminal shrunk below the reserved height can never emit
  // an invalid `${ESC}[0;1H` / `${ESC}[-1;1H` (normal terminals are >= MIN_ROWS,
  // where the clamp is a no-op).
  const segRow = Math.max(1, rows);
  const borderRow = Math.max(1, rows - 1);
  const segs = assemble(barSegments(info), columns, color);

  return (
    `${ESC}[${borderRow};1H${ESC}[2K${topBorder(columns, color)}` +
    `${ESC}[${segRow};1H${ESC}[2K${segs}`
  );
}

/**
 * The escape sequence that paints the boxed bar on the reserved bottom TWO rows
 * WITHOUT moving the user's cursor: save → border row → segments row → restore.
 * Pure and width-aware, so it can be asserted in tests with no terminal.
 */
export function buildBarFrame(
  info: IStatusInfo,
  columns: number,
  rows: number,
  color: boolean
): string {
  return (
    `${ESC}7` + // save cursor
    buildBarBody(info, columns, rows, color) +
    `${ESC}8` // restore cursor
  );
}

/** Horizontally scroll a single-line buffer so the cursor stays visible within
 *  `avail` columns: shows the whole line when it fits, else a window ending at
 *  the cursor. Returns the visible slice and the cursor's column WITHIN it. */
function clipInput(
  line: string,
  cursor: number,
  avail: number
): { visible: string; cursorCol: number } {
  if (avail <= 0) {
    return { visible: "", cursorCol: 0 };
  }

  if (line.length <= avail) {
    return { visible: line, cursorCol: cursor };
  }

  const start = Math.max(0, cursor - avail + 1);

  return {
    visible: line.slice(start, start + avail),
    cursorCol: cursor - start,
  };
}

/**
 * The escape sequence that paints the editable input row (`› <text>`) on the
 * row just above the bar and LEAVES the cursor parked there at the typing
 * column — the stable input line the user edits while agent output streams into
 * the scroll region above. Pure/width-aware for FakeTerm assertions.
 */
export function buildInputFrame(
  line: string,
  cursor: number,
  columns: number,
  rows: number,
  color: boolean
): string {
  // Clamp to row 1 so a shrunk terminal can't emit an invalid `${ESC}[0;1H`
  // (normal terminals are >= MIN_ROWS, where this is a no-op).
  const inputRow = Math.max(1, rows - 2);
  const avail = Math.max(0, columns - PROMPT_COLS);
  const { visible, cursorCol } = clipInput(line, cursor, avail);

  return (
    `${ESC}[${inputRow};1H${ESC}[2K` +
    paint(PROMPT, STYLE.dim, color) +
    visible +
    `${ESC}[${inputRow};${PROMPT_COLS + cursorCol + 1}H`
  );
}

/**
 * The escape sequence that paints a multi-row editor input block ABOVE the input row,
 * cleared and redrawn in place each call. `lines` are the visual rows (wrapped);
 * `cursorRow` and `cursorCol` position the cursor within them. The block is pinned
 * absolutely, with the cursor left parked at the typing position.
 * Pure/width-aware for FakeTerm assertions.
 */
export function buildEditorFrame(
  lines: readonly string[],
  cursorRow: number,
  cursorCol: number,
  columns: number,
  rows: number,
  color: boolean
): string {
  // columns and color kept for API consistency with buildInputFrame;
  // future editors may use them for width-aware wrapping or syntax highlighting.
  void columns;

  void color;

  const inputRow = Math.max(1, rows - 2);

  // The editor block sits above the input row; clamp the starting row to 1.
  const blockStart = Math.max(1, inputRow - lines.length);
  let out = "";

  // Clear and render each line of the editor block
  for (let i = 0; i < lines.length; i += 1) {
    const row = blockStart + i;
    const line = lines[i] ?? "";

    // Position at row, clear the line, then write the content
    out += `${ESC}[${row};1H${ESC}[2K${line}`;
  }

  // Park the cursor at (blockStart + cursorRow, cursorCol + 1)
  const cursorAbsRow = blockStart + cursorRow;

  out += `${ESC}[${cursorAbsRow};${cursorCol + 1}H`;

  return out;
}

/**
 * Paint a transient popup of `lines` directly ABOVE the input row (an `@`-file
 * dropdown), bottom-aligned against the prompt. `clearRows` is the height of the
 * previous popup so a shrinking list erases its old top rows. Pure/width-aware:
 * positions absolutely, clears each row first, and writes nothing into the bar or
 * input row (the caller repaints those). Clamped so it never addresses above row 1.
 */
export function buildOverlayFrame(
  lines: readonly string[],
  clearRows: number,
  rows: number
): string {
  const inputRow = Math.max(1, rows - 2);
  const count = Math.min(
    Math.max(lines.length, clearRows),
    Math.max(0, inputRow - 1)
  );
  const blank = count - lines.length; // cleared (old) rows sit above the new list
  let out = "";

  for (let i = 0; i < count; i += 1) {
    const row = Math.max(1, inputRow - count + i);
    const line = i - blank >= 0 ? (lines[i - blank] ?? "") : "";

    out += `${ESC}[${row};1H${ESC}[2K${line}`;
  }

  return out;
}

/**
 * An always-visible status bar pinned to the terminal's bottom via an ANSI scroll
 * region (DECSTBM). Streaming output and readline input scroll in the region
 * above it; the bar is repainted on state changes and resize. Inactive (no-op)
 * whenever the output isn't a usable TTY — the CLI then prints the inline
 * `renderStatus` line instead, so pipes and `--log` are unaffected.
 */
export class StatusBar {
  private installed = false;
  /** Mirror of the editable buffer (input-row mode only), so a bar repaint or a
   *  stream chunk can re-paint the input row and re-park the cursor. */
  private line = "";
  private cursorPos = 0;
  /** Height of the `@`-picker popup currently painted above the input row (0 = none),
   *  so the next paint knows how many old rows to erase. */
  private overlayRows = 0;

  constructor(
    private readonly out: IStatusBarTerminal,
    private readonly enabled = true,
    private readonly color = true,
    /** Reserve an extra editable input row above the bar and park the cursor on
     *  it. The CLI enables this only on a real TTY tall enough to host it; when
     *  off, behaviour is identical to the original 2-row bar. */
    private readonly withInput = false
  ) {}

  /** Whether the bar is currently pinned (false ⇒ caller uses the inline line). */
  get active(): boolean {
    return this.installed;
  }

  /** Bottom rows reserved: the 2-row bar, plus the input row when enabled. */
  private get reserved(): number {
    return this.withInput ? RESERVED_ROWS + 1 : RESERVED_ROWS;
  }

  private canActivate(): boolean {
    return (
      this.enabled &&
      this.out.isTTY === true &&
      (this.out.rows ?? 0) >= MIN_ROWS
    );
  }

  /** Reserve the bottom rows and draw the bar. No-op if it can't activate. */
  install(info: IStatusInfo): void {
    if (this.installed || !this.canActivate()) {
      return;
    }

    const rows = this.out.rows ?? 0;

    this.out.write("\n".repeat(this.reserved)); // make room for the bar
    this.out.write(`${ESC}[1;${rows - this.reserved}r`); // confine scrolling
    this.out.write(`${ESC}[${rows - this.reserved};1H`); // cursor back in-region
    this.installed = true;

    // Save the in-region cursor as the STREAM cursor; writeStream restores to it
    // before each chunk and re-saves after, so output scrolls in-region while the
    // live cursor rests on the input row below.
    if (this.withInput) {
      this.out.write(`${ESC}7`);
    }

    this.update(info);
  }

  /** Repaint the bar with the latest state (and the input row, in input mode). */
  update(info: IStatusInfo): void {
    if (!this.installed) {
      return;
    }

    const columns = this.out.columns ?? 80;
    const rows = this.out.rows ?? 0;

    if (this.withInput) {
      // Absolute-positioned body (no save/restore — that slot holds the stream
      // cursor), then re-park the cursor on the input row.
      this.out.write(buildBarBody(info, columns, rows, this.color));
      this.paintInput();

      return;
    }

    this.out.write(buildBarFrame(info, columns, rows, this.color));
  }

  /** Update the editable buffer mirror and repaint the input row (input mode). */
  setInput(line: string, cursor: number): void {
    this.line = line;
    this.cursorPos = cursor;

    if (this.installed && this.withInput) {
      this.paintInput();
    }
  }

  /** Write agent output INTO the scroll region, keeping the input row and cursor
   *  stable below it. Falls back to a plain write when the input row isn't active
   *  (non-TTY, small terminal, or not installed) — the original behaviour. */
  writeStream(text: string): void {
    if (!this.installed || !this.withInput) {
      this.out.write(text);

      return;
    }

    this.out.write(`${ESC}8`); // restore stream cursor (into the region)
    this.out.write(text); // scrolls within the region
    this.out.write(`${ESC}7`); // save the advanced stream cursor
    this.out.write(RESET_SGR); // don't bleed mid-stream color into the input row
    this.paintInput();
  }

  /** Paint the `@`-picker dropdown of `lines` just above the input row, then
   *  repaint the bar + input row and re-park the cursor. Safe to call repeatedly as
   *  the list filters — a shrinking list erases its old rows. Input-row mode only;
   *  a no-op otherwise (the caller then has no inline surface and skips the picker). */
  setOverlay(lines: readonly string[], info: IStatusInfo): void {
    if (!this.installed || !this.withInput) {
      return;
    }

    const columns = this.out.columns ?? 80;
    const rows = this.out.rows ?? 0;

    this.out.write(buildOverlayFrame(lines, this.overlayRows, rows));
    this.overlayRows = lines.length;
    this.out.write(buildBarBody(info, columns, rows, this.color));
    this.paintInput();
  }

  /** Erase the `@`-picker dropdown and repaint the bar + input row. Idempotent. */
  clearOverlay(info: IStatusInfo): void {
    if (!this.installed || !this.withInput || this.overlayRows === 0) {
      return;
    }

    const columns = this.out.columns ?? 80;
    const rows = this.out.rows ?? 0;

    this.out.write(buildOverlayFrame([], this.overlayRows, rows));
    this.overlayRows = 0;
    this.out.write(buildBarBody(info, columns, rows, this.color));
    this.paintInput();
  }

  private paintInput(): void {
    this.out.write(
      buildInputFrame(
        this.line,
        this.cursorPos,
        this.out.columns ?? 80,
        this.out.rows ?? 0,
        this.color
      )
    );
  }

  /** Render a multi-row editor input block above the status bar. Each repaint
   *  clears the previous frame and redraws in place (absolute positioning).
   *  Input-row mode only; a no-op otherwise. The cursor is left parked at the
   *  editor's cursor position. */
  setEditor(
    lines: readonly string[],
    cursorRow: number,
    cursorCol: number
  ): void {
    if (!this.installed || !this.withInput) {
      return;
    }

    const columns = this.out.columns ?? 80;
    const rows = this.out.rows ?? 0;

    // Clamp the block height to the available rows above the input row
    const inputRow = Math.max(1, rows - 2);
    const maxRows = Math.max(0, inputRow - 1);
    const clamped = lines.slice(0, maxRows);

    this.out.write(
      buildEditorFrame(clamped, cursorRow, cursorCol, columns, rows, this.color)
    );
  }

  /** Re-apply the scroll region after a terminal resize, then repaint. */
  resize(info: IStatusInfo): void {
    if (!this.installed) {
      return;
    }

    const rows = this.out.rows ?? 0;

    // Clamp to row 1: a resize BELOW `reserved` (a terminal shrunk after install)
    // would otherwise make `rows - reserved` non-positive and emit invalid
    // `${ESC}[1;-1r` / `${ESC}[-1;1H` sequences. Mirrors teardown()'s clamp.
    const regionEnd = Math.max(1, rows - this.reserved);

    this.out.write(`${ESC}[1;${regionEnd}r`);

    // The saved stream cursor may now point off-screen — re-anchor it to the
    // bottom of the (resized) region so output continues there.
    if (this.withInput) {
      this.out.write(`${ESC}[${regionEnd};1H`);
      this.out.write(`${ESC}7`);
    }

    this.update(info);
  }

  /** Reset the scroll region, clear the reserved rows, and show the cursor. Idempotent. */
  teardown(): void {
    if (!this.installed) {
      return;
    }

    const rows = this.out.rows ?? 0;

    this.out.write(`${ESC}[r`); // reset scroll region to full screen

    // Clamp to row 1: a resize below `reserved` after install would otherwise
    // make the start non-positive and emit invalid `${ESC}[0;1H` sequences.
    const startRow = Math.max(1, rows - this.reserved + 1);

    for (let row = startRow; row <= rows; row += 1) {
      this.out.write(`${ESC}[${row};1H${ESC}[2K`); // clear each reserved row
    }

    this.out.write(`${ESC}[?25h`); // ensure the cursor is visible
    this.installed = false;
  }
}
