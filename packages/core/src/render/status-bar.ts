import type { IStatusInfo } from "./render.types";
import { STYLE, paint } from "./style";
import { displayWidth, graphemes } from "./width";
import { computeRegions } from "./layout";
import { ScreenBuffer } from "./screen";

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
    const add = (painted.length > 0 ? sep.length : 0) + displayWidth(seg.text);

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
  // Absolute rows come from the shared layout helper (clamped to row 1, so a
  // terminal shrunk below the reserved height never emits an invalid sequence).
  const { segRow, borderRow } = computeRegions({ rows });
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

  // `cursor` is a code-unit offset (from readline); its on-screen column is the
  // display width of the text before it.
  const cursorCol = displayWidth(line.slice(0, cursor));

  if (displayWidth(line) <= avail) {
    return { visible: line, cursorCol };
  }

  // Wider than the window: show a grapheme-aligned window of `avail` columns with
  // the cursor parked near the right edge. The cursor's grapheme index is found
  // from its code-unit offset, then we keep up to `avail - 1` columns to its left
  // (reserving the last column for the cursor / one cell of look-ahead) and fill
  // the window rightward — so a wide cell is never split.
  const gs = graphemes(line);
  let cursorG = gs.length;
  let consumed = 0;

  for (let i = 0; i < gs.length; i += 1) {
    if (consumed >= cursor) {
      cursorG = i;
      break;
    }

    consumed += (gs[i] ?? "").length;
  }

  let leftCols = 0;
  let startG = cursorG;

  for (let i = cursorG - 1; i >= 0; i -= 1) {
    const w = displayWidth(gs[i] ?? "");

    if (leftCols + w > avail - 1) {
      break;
    }

    leftCols += w;
    startG = i;
  }

  let windowCols = 0;
  let endG = startG;

  for (let i = startG; i < gs.length; i += 1) {
    const w = displayWidth(gs[i] ?? "");

    if (windowCols + w > avail) {
      break;
    }

    windowCols += w;
    endG = i + 1;
  }

  return {
    visible: gs.slice(startG, endG).join(""),
    cursorCol: leftCols,
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
  const { inputRow } = computeRegions({ rows });
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
 * The escape sequence that paints a multi-row editor input block anchored ON the input
 * row (its bottom line rests there; extra lines grow upward), cleared and redrawn in
 * place each call. `lines` are the visual rows (wrapped);
 * `cursorRow` and `cursorCol` position the cursor within them. `clearRows` is the height
 * of the previous block so a shrinking block erases its old top rows. The block is pinned
 * absolutely, with the cursor left parked at the typing position.
 * Pure/width-aware for FakeTerm assertions.
 */
export function buildEditorFrame(
  lines: readonly string[],
  cursorRow: number,
  cursorCol: number,
  columns: number,
  rows: number,
  color: boolean,
  clearRows = 0
): string {
  // columns and color kept for API consistency with buildInputFrame;
  // future editors may use them for width-aware wrapping or syntax highlighting.
  void columns;

  void color;

  const { inputRow } = computeRegions({ rows });
  const maxSpan = inputRow;

  // The block is BOTTOM-anchored ONTO the input row: its last visual row rests on
  // `inputRow` (the cursor's home), and extra rows grow UPWARD from there. Anchoring
  // ON the input row rather than one row above it is what keeps the cursor and the
  // typed text on the SAME row — anchoring above put the text one row above the
  // cursor (the reported desync). `clearRows` (the previous block height) widens the
  // span so a shrinking block erases its old top rows. Mirrors buildOverlayFrame.
  const count = Math.min(Math.max(lines.length, clearRows), maxSpan);
  const blank = Math.max(0, count - lines.length); // cleared rows above content
  const spanTop = Math.max(1, inputRow - count + 1);
  let out = "";

  for (let i = 0; i < count; i += 1) {
    const row = spanTop + i;
    const line = i - blank >= 0 ? (lines[i - blank] ?? "") : "";

    // Position at row, clear the line, then write the content (empty for the
    // cleared rows above the bottom-anchored content).
    out += `${ESC}[${row};1H${ESC}[2K${line}`;
  }

  // Park the cursor relative to the content top (the bottom line is the input row).
  const contentTop = Math.max(1, inputRow - lines.length + 1);
  const cursorAbsRow = contentTop + cursorRow;

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
  const { inputRow } = computeRegions({ rows });
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
  /** Height of the multi-row editor block currently painted above the input row (0 = none),
   *  so the next paint knows how many old rows to erase when the block shrinks. */
  private editorRows = 0;
  /** True once the multi-row editor block is the active editing surface (editor
   *  mode). The cursor then lives IN the block, so bar repaints and stream writes
   *  must NOT re-park it onto the readline input row — doing so was the cursor/text
   *  desync (cursor on the `›` row, text landing in the block above). Set on the
   *  first setEditor; a session never reverts from editor to readline. */
  private editorActive = false;
  /** Absolute (1-based) cursor position the editor block last parked at, so a bar
   *  repaint or stream write can restore it without the editor repainting. */
  private editorCursorAbsRow = 1;
  private editorCursorAbsCol = 1;
  /** The last editor frame (visual lines + in-block cursor), so a stream write can
   *  REPAINT the input block on top of itself — guaranteeing streamed output can
   *  never leave anything sitting on the input row. */
  private editorLines: readonly string[] = [];
  private editorCursorRow = 0;
  private editorCursorCol = 0;
  /** Damage buffer for the bar-owned rows (border, segments, input row). The bar
   *  frames are flushed through it so a repaint emits only the cells that changed
   *  — no full-row `ESC[2K` rewrites, no flicker. The editor block and `@`-picker
   *  popup paint directly (they reclaim scroll-region rows and need explicit
   *  clears), so the buffer never owns those rows. Undefined until install. */
  private screen: ScreenBuffer | undefined;

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
    const { regionEnd } = computeRegions({ rows, reserved: this.reserved });

    this.out.write("\n".repeat(this.reserved)); // make room for the bar
    this.out.write(`${ESC}[1;${regionEnd}r`); // confine scrolling
    this.out.write(`${ESC}[${regionEnd};1H`); // cursor back in-region
    this.installed = true;
    // The bar rows we just made room for are blank, matching the buffer's blank
    // committed grid, so the first repaint emits content with no spurious clears.
    this.screen = new ScreenBuffer(rows, this.out.columns ?? 80);

    // Save the in-region cursor as the STREAM cursor; writeStream restores to it
    // before each chunk and re-saves after, so output scrolls in-region while the
    // live cursor rests on the input row below.
    if (this.withInput) {
      this.out.write(`${ESC}7`);
    }

    this.update(info);
  }

  /**
   * Flush a bar-owned frame (border, segments, input row) through the damage
   * buffer, writing only the cells that changed. `parkOnInput` parks the cursor
   * where the frame left it (the input row); otherwise the delta is wrapped in
   * save/restore so the user's cursor never moves (bar-only mode). Falls back to
   * a direct write if the buffer isn't installed.
   */
  private flushPinned(content: string, parkOnInput: boolean): void {
    if (this.screen === undefined) {
      this.out.write(content);

      return;
    }

    const delta = this.screen.flush(content);

    this.out.write(
      parkOnInput
        ? `${delta}${this.screen.parkSequence()}`
        : `${ESC}7${delta}${ESC}8`
    );
  }

  /** Repaint the bar with the latest state (and the input row, in input mode). */
  update(info: IStatusInfo): void {
    if (!this.installed) {
      return;
    }

    const columns = this.out.columns ?? 80;
    const rows = this.out.rows ?? 0;

    if (this.withInput && !this.editorActive) {
      // Readline input-row mode: bar body + input row in one damage-diffed flush,
      // parking on the input row (the stream-cursor slot is left untouched).
      this.flushPinned(
        buildBarBody(info, columns, rows, this.color) +
          buildInputFrame(this.line, this.cursorPos, columns, rows, this.color),
        true
      );

      return;
    }

    if (this.editorActive) {
      // Editor mode: repaint the bar body, then restore the cursor to the editor
      // block via absolute CUP. CRITICAL: do NOT use ESC7/ESC8 here — the terminal
      // has a single cursor-save slot, and writeStream uses it to remember where the
      // streamed response continues. A bar repaint (spinner tick) between two
      // response tokens would otherwise overwrite that save with the editor cursor,
      // so the next token lands on the INPUT row instead of in the scroll region.
      const barBody = buildBarBody(info, columns, rows, this.color);
      const delta =
        this.screen === undefined ? barBody : this.screen.flush(barBody);

      this.out.write(
        `${delta}${ESC}[${this.editorCursorAbsRow};${this.editorCursorAbsCol}H`
      );

      return;
    }

    // Bar-only (no input row): no stream cursor to protect, so save/restore is fine.
    this.flushPinned(buildBarBody(info, columns, rows, this.color), false);
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

    // The editor put the terminal in raw mode (ONLCR off), so a bare "\n" is a
    // line-feed with NO carriage return — streamed output would staircase to the
    // right ("text jumps"). Normalize to CRLF so every line restarts at column 1.
    const normalized = text.replace(/\r?\n/gu, "\r\n");

    this.out.write(`${ESC}8`); // restore stream cursor (into the region)
    this.out.write(normalized); // scrolls within the region
    this.out.write(`${ESC}7`); // save the advanced stream cursor
    this.out.write(RESET_SGR); // don't bleed mid-stream color into the input row

    if (this.editorActive) {
      // Repaint the whole input block on top of itself: even if a streamed chunk
      // ever reached the input row, the editor reclaims it immediately (and the
      // cursor lands back in the block). The input can never be left overwritten.
      this.repaintEditorBlock();

      return;
    }

    this.paintInput();
  }

  /** Re-emit the last editor frame (clears + redraws its rows, parks the cursor in
   *  the block). Used after a stream write so the input block stays intact on top. */
  private repaintEditorBlock(): void {
    this.out.write(
      buildEditorFrame(
        this.editorLines,
        this.editorCursorRow,
        this.editorCursorCol,
        this.out.columns ?? 80,
        this.out.rows ?? 0,
        this.color,
        this.editorRows
      )
    );
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

    // The popup paints directly (it reclaims scroll-region rows above the input
    // row); the bar + input row repaint goes through the damage buffer.
    this.out.write(buildOverlayFrame(lines, this.overlayRows, rows));
    this.overlayRows = lines.length;
    this.repaintBarAndInput(info, columns, rows);
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
    this.repaintBarAndInput(info, columns, rows);
  }

  /** Bar body + input row in one damage-diffed flush (parking on the input row). */
  private repaintBarAndInput(
    info: IStatusInfo,
    columns: number,
    rows: number
  ): void {
    this.flushPinned(
      buildBarBody(info, columns, rows, this.color) +
        buildInputFrame(this.line, this.cursorPos, columns, rows, this.color),
      true
    );
  }

  private paintInput(): void {
    this.flushPinned(
      buildInputFrame(
        this.line,
        this.cursorPos,
        this.out.columns ?? 80,
        this.out.rows ?? 0,
        this.color
      ),
      true
    );
  }

  /** Render a multi-row editor input block above the status bar. Each repaint
   *  clears the previous frame and redraws in place (absolute positioning).
   *  Input-row mode only; a no-op otherwise. The cursor is left parked at the
   *  editor's cursor position. Shrinking blocks erase old top rows via editorRows.
   *  When the editor height changes, the scroll region is resized so the editor
   *  block is pinned (not scrollable) — streaming only scrolls above it. */
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

    // Clamp the block height to the rows from the input row upward (it may use
    // the input row itself now).
    const { inputRow } = computeRegions({ rows });
    const maxRows = inputRow;
    const clamped = lines.slice(0, maxRows);
    const newHeight = clamped.length;

    // The block is now the editing surface, so bar repaints/stream writes must
    // re-park onto the block, not the readline input row.
    this.editorActive = true;

    // Remember where the block parks the cursor (mirrors buildEditorFrame — the
    // bottom line rests on the input row), so a bar repaint or stream write can
    // restore it without the editor repainting.
    const contentTop = Math.max(1, inputRow - newHeight + 1);

    this.editorCursorAbsRow = contentTop + cursorRow;
    this.editorCursorAbsCol = cursorCol + 1;
    this.editorLines = clamped;
    this.editorCursorRow = cursorRow;
    this.editorCursorCol = cursorCol;

    // If editor height changes, resize the scroll region to exclude the rows the
    // block uses ABOVE the input row (newHeight - 1; the input row is already in
    // `reserved`). This pins the editor block + bar so they never scroll.
    if (newHeight !== this.editorRows) {
      const { regionEnd } = computeRegions({
        rows,
        reserved: this.reserved,
        editorRows: Math.max(0, newHeight - 1),
      });

      this.out.write(`${ESC}[1;${regionEnd}r`);

      // Re-anchor the stream cursor to the new region boundary
      this.out.write(`${ESC}[${regionEnd};1H`);
      this.out.write(`${ESC}7`);
    }

    this.out.write(
      buildEditorFrame(
        clamped,
        cursorRow,
        cursorCol,
        columns,
        rows,
        this.color,
        this.editorRows
      )
    );
    this.editorRows = newHeight;
  }

  /** Paint a completion dropdown of `lines` directly ABOVE the editor block (the
   *  block is anchored on the input row and grows upward; the dropdown sits above
   *  its top row), then re-park the cursor in the block so typing continues there.
   *  Pass `[]` (or call clearEditorOverlay) to erase it. Editor mode only. */
  setEditorOverlay(lines: readonly string[]): void {
    if (!this.installed || !this.withInput) {
      return;
    }

    const rows = this.out.rows ?? 0;
    const { inputRow } = computeRegions({ rows });
    // Top row of the editor block: it occupies [inputRow - editorRows + 1, inputRow].
    const blockTop = Math.max(1, inputRow - Math.max(1, this.editorRows) + 1);
    const maxSpan = Math.max(0, blockTop - 1);
    const count = Math.min(Math.max(lines.length, this.overlayRows), maxSpan);
    const blank = Math.max(0, count - lines.length); // old rows blanked above the list
    let out = "";

    for (let i = 0; i < count; i += 1) {
      const row = Math.max(1, blockTop - count + i);
      const line = i - blank >= 0 ? (lines[i - blank] ?? "") : "";

      out += `${ESC}[${row};1H${ESC}[2K${line}`;
    }

    this.overlayRows = lines.length;
    // Re-park in the editor block (where setEditor last placed the cursor).
    out += `${ESC}[${this.editorCursorAbsRow};${this.editorCursorAbsCol}H`;
    this.out.write(out);
  }

  /** Erase the editor-block completion dropdown. Idempotent. */
  clearEditorOverlay(): void {
    if (this.overlayRows === 0) {
      return;
    }

    this.setEditorOverlay([]);
  }

  /** Re-apply the scroll region after a terminal resize, then repaint. */
  resize(info: IStatusInfo): void {
    if (!this.installed) {
      return;
    }

    const rows = this.out.rows ?? 0;
    const columns = this.out.columns ?? 0;

    // Terminals emit transient 0×0 sizes on minimize/resize; resizing the buffer
    // to 0 rows would drop its committed state and wedge later paints. Skip until
    // a real size arrives (the editor path guards the same way in cli.ts).
    if (rows <= 0 || columns <= 0) {
      return;
    }

    // computeRegions clamps to row 1: a resize BELOW `reserved` (a terminal
    // shrunk after install) would otherwise make the boundary non-positive and
    // emit invalid `${ESC}[1;-1r` / `${ESC}[-1;1H` sequences. The editor block is
    // excluded from the scrollable region.
    const { regionEnd } = computeRegions({
      rows,
      reserved: this.reserved,
      editorRows: Math.max(0, this.editorRows - 1),
    });

    this.out.write(`${ESC}[1;${regionEnd}r`);

    // The terminal reflowed: resize the damage buffer to the new dimensions and
    // drop its committed state so the next update repaints the bar in full.
    this.screen?.resize(rows, columns);

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
    this.editorRows = 0; // reset editor block height
    this.screen = undefined; // next install starts a fresh damage buffer
  }
}
