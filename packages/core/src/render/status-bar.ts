import type { IStatusInfo } from "./render.types";
import { humanDuration } from "./human-duration";
import { STYLE, paint } from "./style";
import { displayWidth, graphemes } from "./width";

const ESC = "\x1b";

/** Below this height, a 2-row bar would crowd the conversation — fall back to inline. */
export const MIN_ROWS = 5;

/** Reset all SGR attributes — written after a stream chunk so the input row below
 *  it is never painted in leftover color from mid-stream markdown. */
const RESET_SGR = `${ESC}[0m`;

/** The editable input prompt and the columns it occupies (`›` + space). The editor
 *  block reserves the same gutter (see PROMPT_COLS export) so the prompt stays put
 *  when typing switches the input surface from the placeholder row to the editor. */
const PROMPT = "› ";

export const PROMPT_COLS = 2;

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

  // Current interactive mode chip — kept early so it survives when the bar is
  // truncated on a narrow terminal (segments drop from the right).
  if (info.mode !== undefined && info.mode.length > 0) {
    segs.push({ text: `◆ ${info.mode}`, code: STYLE.brandLight });
  }

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
      text: `↻ ${info.turns}·${humanDuration(info.elapsedMs)}`,
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

/**
 * Same metrics line (model, mode, activity, meter, tok/s, turns, status, scope).
 * Shared formatter for pane-console footer chrome and StatusBar unit tests.
 */
export function formatStatusBarLine(
  info: IStatusInfo,
  columns: number,
  color = true
): string {
  return assemble(barSegments(info), columns, color);
}

/** A dim rule with a leading corner tick, spanning the width. */
function topBorder(columns: number, color: boolean): string {
  return paint(`╶${"─".repeat(Math.max(0, columns - 3))}`, STYLE.dim, color);
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
 * An always-visible status bar pinned to the terminal's bottom via an ANSI scroll
 * region (DECSTBM). Streaming output and readline input scroll in the region
 * above it; the bar is repainted on state changes and resize. Inactive (no-op)
 * whenever the output isn't a usable TTY — the CLI then prints the inline
 * `renderStatus` line instead, so pipes and `--log` are unaffected.
 */
export class StatusBar {
  private installed = false;
  /** RELATIVE-REDRAW MODEL (log-update style, resize-proof). The live region (an
   *  optional overlay + the input/editor surface + the 2-row bar) is drawn as the
   *  LAST lines of the terminal, right after the conversation — NOT pinned to the
   *  screen bottom via a scroll region. Every repaint moves the cursor to the
   *  region's top and `ESC[0J`-erases to end of screen (reflow-proof: it clears the
   *  region wherever a resize-reflow moved it), then redraws. No DECSTBM, no
   *  absolute row math, so a resize can never orphan a bar mid-screen. */
  private liveRows = 0; // terminal rows the live region currently occupies
  private liveCursorRow = 0; // cursor's row WITHIN the region (0 = its top line)
  /** Display columns of the current UNTERMINATED content line — i.e. streamed
   *  output written since the last newline, which the region sits one line below.
   *  0 means content ended on a line boundary (region starts on that line). Lets a
   *  later writeStream CONTINUE a partial line instead of splitting the response. */
  private pendingCols = 0;
  /** Last status info, cached so setInput/setEditor/writeStream can redraw the WHOLE
   *  region (which includes the bar) without the caller re-supplying it. */
  private lastInfo: IStatusInfo | null = null;
  /** Mirror of the readline input buffer (readline mode only). */
  private line = "";
  private cursorPos = 0;
  /** True once the multi-row editor block is the active input surface (editor mode). */
  private editorActive = false;
  private editorLines: readonly string[] = [];
  private editorCursorRow = 0;
  private editorCursorCol = 0;
  /** Extra lines shown ABOVE the input surface (the `@`-picker / command palette). */
  private overlayLines: readonly string[] = [];
  /** The live agent tree (+ optional detail pane), pinned at the TOP of the live
   *  region — above the overlay and input — while subagents run. Its own slot so
   *  it composes with the `@`-picker/palette overlay instead of fighting it. */
  private agentTreeLines: readonly string[] = [];
  /** Worklist checklist slot (gate-derived ticks), below the agent tree and above
   *  the overlay/input. */
  private worklistLines: readonly string[] = [];
  /** While a drag-resize storm is in flight, ALL painting is suspended and streamed
   *  output is buffered; flushed once the size settles (so the region isn't churned
   *  against a reflowing terminal). */
  private paused = false;
  private pendingStream = "";

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

  private canActivate(): boolean {
    return (
      this.enabled &&
      this.out.isTTY === true &&
      (this.out.rows ?? 0) >= MIN_ROWS
    );
  }

  /** Build the live region as an ordered array of terminal lines (top→bottom):
   *  any overlay lines, then the input surface (editor block or the `› …` row),
   *  then the bar's border rule + segments. Also returns the cursor's row/col
   *  WITHIN the region. Each line is ≤ `columns` wide so none wraps (which would
   *  break the row bookkeeping). */
  private buildRegionLines(): {
    lines: string[];
    cursorRow: number;
    cursorCol: number;
  } {
    const columns = this.out.columns ?? 80;
    const info = this.lastInfo;
    const lines: string[] = [
      ...this.agentTreeLines,
      ...this.worklistLines,
      ...this.overlayLines,
    ];
    let cursorRow: number;
    let cursorCol: number;

    if (this.editorActive) {
      // Paint the `› ` prompt in front of the editor block (continuation rows keep
      // the same 2-col gutter) so it never vanishes when typing activates the
      // editor. The editor reserves PROMPT_COLS, so composed rows stay ≤ columns.
      const gutter = paint(PROMPT, STYLE.dim, this.color);
      const indent = " ".repeat(PROMPT_COLS);

      cursorRow = lines.length + this.editorCursorRow;
      cursorCol = PROMPT_COLS + this.editorCursorCol;
      lines.push(
        ...this.editorLines.map((line, i) =>
          i === 0 ? `${gutter}${line}` : `${indent}${line}`
        )
      );
    } else {
      const avail = Math.max(0, columns - PROMPT_COLS);
      const clipped = clipInput(this.line, this.cursorPos, avail);

      lines.push(paint(PROMPT, STYLE.dim, this.color) + clipped.visible);
      cursorRow = lines.length - 1;
      cursorCol = PROMPT_COLS + clipped.cursorCol;
    }

    if (info !== null) {
      lines.push(topBorder(columns, this.color));
      lines.push(assemble(barSegments(info), columns, this.color));
    }

    return { lines, cursorRow, cursorCol };
  }

  /** Repaint the whole live region in place: go to its top, `ESC[0J`-erase to end
   *  of screen (reflow-proof — clears the region wherever a resize moved it), draw
   *  its lines, and park the cursor inside it. This is the single paint primitive;
   *  every state change routes through it. */
  private renderRegion(): void {
    if (!this.installed || this.paused || this.lastInfo === null) {
      return;
    }

    const { lines, cursorRow, cursorCol } = this.buildRegionLines();
    let out = "";

    if (this.liveRows > 0) {
      // Cursor is parked inside the current region; climb to its top, then erase.
      if (this.liveCursorRow > 0) {
        out += `${ESC}[${this.liveCursorRow}A`;
      }

      out += `\r${ESC}[0J`;
    } else if (this.pendingCols > 0) {
      // Content ended mid-line: open a fresh line below it for the region, leaving
      // the partial line intact (a later writeStream continues it).
      out += `\r\n${ESC}[0J`;
    } else {
      out += `\r${ESC}[0J`;
    }

    out += RESET_SGR + lines.join("\r\n");

    // Park at (cursorRow, cursorCol) measured from the region's top line.
    const up = lines.length - 1 - cursorRow;

    if (up > 0) {
      out += `${ESC}[${up}A`;
    }

    out += "\r";

    if (cursorCol > 0) {
      out += `${ESC}[${cursorCol}C`;
    }

    this.out.write(out);
    this.liveRows = lines.length;
    this.liveCursorRow = cursorRow;
  }

  /** Draw the live region for the first time, just below the current content. */
  install(info: IStatusInfo): void {
    if (this.installed || !this.canActivate()) {
      return;
    }

    this.installed = true;
    this.lastInfo = info;
    this.pendingCols = 0; // the banner/help text above ends on its own line
    this.liveRows = 0;
    this.liveCursorRow = 0;
    this.renderRegion();
  }

  /** Repaint the region with the latest status info (spinner tick / state change). */
  update(info: IStatusInfo): void {
    this.lastInfo = info; // cache even while paused, so the settle repaint is current

    if (!this.installed || this.paused) {
      return;
    }

    this.renderRegion();
  }

  /** Update the readline input mirror and repaint (readline mode only). */
  setInput(line: string, cursor: number): void {
    this.line = line;
    this.cursorPos = cursor;

    if (this.installed && this.withInput && !this.editorActive) {
      this.renderRegion();
    }
  }

  /** Write agent output as normal scrollback, keeping the live region below it.
   *  Erases the region, writes the (CRLF-normalized) content where the region sat
   *  — i.e. right after the prior conversation — then redraws the region beneath.
   *  Falls back to a plain write when the region isn't active (non-TTY / small). */
  writeStream(text: string): void {
    if (!this.installed || !this.withInput) {
      this.out.write(text);

      return;
    }

    // During a resize storm, buffer output — writing while the size churns would
    // fight the reflow. flushStream() replays it once the size settles.
    if (this.paused) {
      this.pendingStream += text;

      return;
    }

    let out = "";

    // Move to the content append point: the end of the current partial line if
    // there is one (so tokens continue the same line), else the region's top line.
    if (this.liveRows > 0) {
      if (this.liveCursorRow > 0) {
        out += `${ESC}[${this.liveCursorRow}A`;
      }

      if (this.pendingCols > 0) {
        // The region sits one line below the partial content line; step up onto it
        // and out to its end, then erase the (now-below) region.
        out += `${ESC}[1A\r`;

        if (this.pendingCols > 0) {
          out += `${ESC}[${this.pendingCols}C`;
        }
      } else {
        out += "\r";
      }

      out += `${ESC}[0J`;
    }

    // Raw mode is ONLCR-off, so normalize "\n" → CRLF or output staircases right.
    const normalized = text.replace(/\r?\n/gu, "\r\n");

    out += RESET_SGR + normalized;
    this.out.write(out);
    this.liveRows = 0;
    this.liveCursorRow = 0;

    // Track the trailing partial line so the NEXT chunk continues it.
    const lastBreak = normalized.lastIndexOf("\r\n");

    if (lastBreak === -1) {
      this.pendingCols += displayWidth(normalized);
    } else {
      this.pendingCols = displayWidth(normalized.slice(lastBreak + 2));
    }

    this.renderRegion();
  }

  /** Suspend all painting for a resize storm: `update`/`writeStream` become no-ops
   *  (streamed output is buffered) so nothing is drawn into the churning, stale
   *  scroll region. Paired with `flushStream` at settle. */
  pauseForResize(): void {
    this.paused = true;
  }

  /** Resume after a resize settles: replay any buffered stream output into the
   *  now-repainted, correctly-regioned screen. Call AFTER `resize()`. */
  flushStream(): void {
    this.paused = false;

    const buffered = this.pendingStream;

    this.pendingStream = "";

    if (buffered.length > 0) {
      this.writeStream(buffered);
    }
  }

  /** Show the `@`-picker / command-palette dropdown as extra lines ABOVE the input
   *  surface, then repaint. `[]` clears it. */
  setOverlay(lines: readonly string[], info: IStatusInfo): void {
    this.lastInfo = info;
    this.overlayLines = lines;

    if (this.installed && this.withInput) {
      this.renderRegion();
    }
  }

  /** Show/replace the live agent tree above the input row, then repaint. `[]`
   *  clears it. Repainted through the same relative-redraw as everything else,
   *  so it composes with a streaming transcript and the input surface. */
  setAgentTree(lines: readonly string[]): void {
    this.agentTreeLines = lines;

    if (this.installed && this.withInput) {
      this.renderRegion();
    }
  }

  /** Erase the agent tree and repaint. Idempotent. */
  clearAgentTree(): void {
    if (this.agentTreeLines.length === 0) {
      return;
    }

    this.agentTreeLines = [];

    if (this.installed && this.withInput) {
      this.renderRegion();
    }
  }

  /** Show/replace the worklist checklist above the input row, then repaint. */
  setWorklist(lines: readonly string[]): void {
    this.worklistLines = lines;

    if (this.installed && this.withInput) {
      this.renderRegion();
    }
  }

  /** Erase the worklist slot and repaint. Idempotent. */
  clearWorklist(): void {
    if (this.worklistLines.length === 0) {
      return;
    }

    this.worklistLines = [];

    if (this.installed && this.withInput) {
      this.renderRegion();
    }
  }

  /** Erase the `@`-picker dropdown and repaint. Idempotent. */
  clearOverlay(info: IStatusInfo): void {
    this.lastInfo = info;

    if (this.overlayLines.length === 0) {
      return;
    }

    this.overlayLines = [];

    if (this.installed && this.withInput) {
      this.renderRegion();
    }
  }

  /** Set the multi-row editor block as the input surface and repaint. `lines` are
   *  the already-wrapped visual rows (each ≤ columns); `cursorRow`/`cursorCol` are
   *  the cursor's position within them. */
  setEditor(
    lines: readonly string[],
    cursorRow: number,
    cursorCol: number
  ): void {
    this.editorActive = true;
    this.editorLines = lines;
    this.editorCursorRow = cursorRow;
    this.editorCursorCol = cursorCol;

    if (this.installed && this.withInput) {
      this.renderRegion();
    }
  }

  /** Editor-mode completion dropdown — same overlay slot as `setOverlay`. */
  setEditorOverlay(lines: readonly string[]): void {
    this.overlayLines = lines;

    if (this.installed && this.withInput) {
      this.renderRegion();
    }
  }

  /** Erase the editor-block completion dropdown. Idempotent. */
  clearEditorOverlay(): void {
    if (this.overlayLines.length === 0) {
      return;
    }

    this.overlayLines = [];

    if (this.installed && this.withInput) {
      this.renderRegion();
    }
  }

  /** Repaint after a terminal resize. No scroll region to re-apply and no absolute
   *  rows to reconcile: renderRegion() climbs to the region's top (relative to the
   *  cursor, which the terminal keeps with its content line through reflow) and
   *  `ESC[0J`-erases before redrawing — so a reflow can't strand a bar. Debounced
   *  by the caller; painting is paused mid-storm and this runs once at settle. */
  resize(info: IStatusInfo): void {
    if (!this.installed) {
      return;
    }

    this.lastInfo = info;

    const rows = this.out.rows ?? 0;
    const columns = this.out.columns ?? 0;

    // Terminals emit transient 0×0 sizes on minimize; skip until a real size lands.
    if (rows <= 0 || columns <= 0) {
      return;
    }

    this.paused = false;
    this.renderRegion();
  }

  /** Erase the live region (leaving the conversation above intact), show the
   *  cursor, and deactivate. Idempotent. */
  teardown(): void {
    if (!this.installed) {
      return;
    }

    let out = "";

    if (this.liveCursorRow > 0) {
      out += `${ESC}[${this.liveCursorRow}A`;
    }

    out += `\r${ESC}[0J${ESC}[?25h`;
    this.out.write(out);

    this.installed = false;
    this.liveRows = 0;
    this.liveCursorRow = 0;
    this.editorActive = false;
    this.overlayLines = [];
    this.agentTreeLines = [];
    this.paused = false;
    this.pendingStream = "";
  }
}
