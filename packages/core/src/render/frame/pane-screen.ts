import type { IPaneInput } from "./frame.types";
import type { IStatusInfo } from "../render.types";
import {
  BEGIN_SYNC,
  CLEAR_SCREEN,
  CURSOR_BLINK_BLOCK,
  CURSOR_COLOR_DEFAULT,
  CURSOR_COLOR_GREEN,
  CURSOR_SHAPE_DEFAULT,
  DISABLE_MOUSE,
  ENABLE_MOUSE,
  END_SYNC,
  ENTER_ALT,
  EXIT_ALT,
  EL_EOL,
  SHOW_CURSOR,
  cup,
} from "./codes";
import {
  CHROME_PAD_X,
  CONSOLE,
  formatConsoleTopbar,
  formatRailTitleBlock,
  insetInnerCols,
  insetX,
  RAIL_TITLE_ROWS,
} from "./chrome";
import { CursorState } from "./cursor-state";
import { fitAnsiLine } from "./fit-line";
import {
  formatInputBox,
  formatInputStatusLabel,
  INPUT_EDITOR_GUTTER,
  INPUT_PROMPT,
  INPUT_PROMPT_COLS,
  inputCursorCol,
} from "./input-box";
import { withOpaqueBg } from "./opaque-bg";
import { PaneFocus } from "./focus";
import {
  BODY_GAP_ROWS,
  BODY_HEADER_ROWS,
  canUsePaneTui,
  clampInputInnerRows,
  computeLayout,
  inputBandRows,
  TOP_STATUS_ROWS,
} from "./layout";
import { Scrollback } from "./scrollback";
import { stripSgr } from "./ansi-plain";
import { handleFocusKey, handleMouseKey, handleScrollKey } from "./pane-keys";
import type { PaneKeyResult } from "./pane-keys";
import { STYLE, paint } from "../style";
import { displayWidth } from "../width";
import {
  formatScrollbarColumn,
  overlayScrollbarCol,
} from "./scrollbar";
import {
  frameContentRow,
  outerInsets,
  wrapOuterFrame,
} from "./outer-frame";

export interface IPaneScreenTerminal {
  readonly isTTY?: boolean;
  rows?: number;
  columns?: number;
  write(data: string): boolean;
}

export type { PaneKeyResult };

/**
 * Prompt prefix inside the input box (`> `). Hardware cursor sits after it;
 * placeholder ghost-text fills the draft when idle.
 */
export const FORGE_PROMPT = INPUT_PROMPT;
export const FORGE_PROMPT_COLS = INPUT_PROMPT_COLS;
/** Borders + side pads + prompt — columns the editor must reserve. */
export const FORGE_EDITOR_GUTTER = INPUT_EDITOR_GUTTER;
const FORGE_PLACEHOLDER = "describe a task, or /help";

const GUTTER = "│";
const EMPTY_PANEL_LINES = ["—", "/work"] as const;

/**
 * Interactive console TUI: dense top strip, hairlines, scroll + rail, caret input.
 */
export class PaneScreen {
  private readonly scrollback = new Scrollback();
  private readonly focus = new PaneFocus();
  private readonly cursor = new CursorState();
  private panelLines: readonly string[] = [];
  private overlayLines: readonly string[] = [];
  private agentTreeLines: readonly string[] = [];
  private status: IStatusInfo | null = null;
  private worklistBadge = "";
  private lastTopLine = "";
  private flashHeaderPaints = 0;
  private lastBadge = "";
  private cwd = process.cwd();
  private sessionId = "";
  private input: IPaneInput = { lines: [""], cursorRow: 0, cursorCol: 0 };
  private prevLines: string[] | null = null;
  private lastWrapCols = 0;
  /** When true, next flush homes + erases the alt screen (resize / geom change). */
  private geometryDirty = false;
  /** Panel list scroll offset (lines from top). Independent of main scrollback. */
  private panelOffset = 0;
  private bodyViewportRows = 1;
  private entered = false;
  /** True after a successful enter — resize may re-enter after a shrink-leave. */
  private everEntered = false;
  private rows: number;
  private cols: number;

  constructor(
    private readonly out: IPaneScreenTerminal,
    rows?: number,
    cols?: number
  ) {
    this.rows = rows ?? out.rows ?? 24;
    this.cols = cols ?? out.columns ?? 80;
  }

  get active(): boolean {
    return this.entered;
  }

  get focusState(): PaneFocus {
    return this.focus;
  }

  enter(): boolean {
    // Require an explicit TTY — `undefined` on pipes must not enter alt-screen.
    if (this.out.isTTY !== true || !canUsePaneTui(this.rows)) {
      return false;
    }

    if (this.entered) {
      return true;
    }

    // Alt screen + mouse capture: host terminal must NOT scroll its own buffer.
    // Wheel events become CSI reports; we scroll main/panel viewports only.
    // Green blinking block caret replaces any prompt text.
    this.out.write(
      ENTER_ALT +
        ENABLE_MOUSE +
        CURSOR_COLOR_GREEN +
        CURSOR_BLINK_BLOCK +
        SHOW_CURSOR
    );
    this.entered = true;
    this.everEntered = true;
    this.prevLines = null;
    this.cursor.reset();
    this.panelOffset = 0;
    this.paint();

    return true;
  }

  leave(): void {
    if (!this.entered) {
      return;
    }

    this.out.write(
      DISABLE_MOUSE +
        CURSOR_COLOR_DEFAULT +
        CURSOR_SHAPE_DEFAULT +
        SHOW_CURSOR +
        EXIT_ALT
    );
    this.entered = false;
    this.prevLines = null;
    this.cursor.reset();
    this.panelOffset = 0;
  }

  /** Full clear + redraw (e.g. `/clear`) — invalidates differential cache. */
  clear(): void {
    if (!this.entered) {
      return;
    }

    this.scrollback.clear();
    this.geometryDirty = true;
    this.prevLines = null;
    this.cursor.reset();
    this.panelOffset = 0;
    this.lastWrapCols = 0;
    this.paint();
  }

  resize(rows: number, cols: number): void {
    const nextRows = Math.max(1, rows);
    const nextCols = Math.max(1, cols);
    const geomChanged = nextRows !== this.rows || nextCols !== this.cols;

    this.rows = nextRows;
    this.cols = nextCols;

    if (!canUsePaneTui(nextRows)) {
      if (this.entered) {
        this.leave();
      }

      return;
    }

    // Re-enter after a shrink-leave when the terminal is tall enough again.
    // Never auto-enter a screen that was never started (pipes / plain path).
    if (!this.entered) {
      if (this.everEntered) {
        this.enter();
      }

      return;
    }

    // Full clear on any geometry change — shrink/zoom otherwise leaves ghost cells.
    if (geomChanged) {
      this.geometryDirty = true;
      this.prevLines = null;
      this.cursor.reset();
      // Force wrap reflow on next paint (main cols may change with panel split).
      this.lastWrapCols = 0;
    }

    this.paint();
  }

  appendMain(text: string): void {
    this.scrollback.append(text);

    if (this.entered) {
      this.paint();
    }
  }

  setPanel(lines: readonly string[]): void {
    this.panelLines = lines;
    this.focus.syncHasItems(this.hasPanelContent());
    this.clampPanelOffset();

    if (this.entered) {
      this.paint();
    }
  }

  /** Scroll the main transcript viewport (positive = older). */
  scrollMain(delta: number): void {
    this.scrollback.scroll(delta);

    if (this.entered) {
      this.prevLines = null;
      this.paint();
    }
  }

  /** Scroll the side panel list (positive = later lines). */
  scrollPanel(delta: number): void {
    this.panelOffset = Math.max(0, this.panelOffset + delta);
    this.clampPanelOffset();

    if (this.entered) {
      this.prevLines = null;
      this.paint();
    }
  }

  /** Real worklist items — empty placeholder stays visible but is not focusable. */
  private hasPanelContent(): boolean {
    if (this.panelLines.length === 0) {
      return false;
    }

    const head = stripSgr(this.panelLines[0] ?? "");

    // Empty landing copy in the rail.
    if (
      head === "worklist" ||
      head === "(empty)" ||
      head === "—" ||
      head.startsWith("No worklist") ||
      head === "/work to start" ||
      head === "/work"
    ) {
      return false;
    }

    // Live header is `worklist  N/M` (Tasks title reads counts via badge).
    return /^worklist\s+\d+\/\d+/.test(head) || /^\d+\/\d+$/.test(head);
  }

  private draftInnerRows(): number {
    const n = this.input.lines.length > 0 ? this.input.lines.length : 1;

    return clampInputInnerRows(n);
  }

  private layoutOpts(): {
    rows: number;
    cols: number;
    showPanel: boolean;
    inputInnerRows: number;
  } {
    // Layout runs inside the floating window (margin + border reserved).
    const insets = outerInsets(this.rows, this.cols);

    return {
      rows: insets.contentRows,
      cols: insets.contentCols,
      showPanel: true,
      inputInnerRows: this.draftInnerRows(),
    };
  }

  clearPanel(): void {
    this.setPanel([]);
  }

  setWorklistBadge(badge: string): void {
    if (badge !== this.lastBadge && badge.length > 0) {
      this.flashHeaderPaints = 2;
    }

    this.lastBadge = badge;
    this.worklistBadge = badge;

    if (this.entered) {
      this.paint();
    }
  }

  setBusy(_busy: boolean): void {
    // Reserved for turn-busy chrome; still repaint so callers can rely on a flush.
    if (this.entered) {
      this.paint();
    }
  }

  /** Identity chips for the pinned topbar (cwd + short session id). */
  setHeader(opts: { cwd: string; sessionId?: string }): void {
    this.cwd = opts.cwd;
    this.sessionId = opts.sessionId ?? "";

    if (this.entered) {
      this.prevLines = null;
      this.paint();
    }
  }

  setStatus(info: IStatusInfo): void {
    this.status = info;

    if (!this.entered) {
      return;
    }

    const layout = computeLayout(this.layoutOpts());
    const nextTop =
      layout.top.rows > 0
        ? this.topbarLines(layout.top.cols, layout).join("\n")
        : "";

    if (
      nextTop === this.lastTopLine &&
      this.prevLines !== null &&
      this.flashHeaderPaints === 0
    ) {
      return;
    }

    // Status ticks are the moment stray relative writes (absolute CSI, etc.)
    // most often land in empty main rows. Differential paint would skip those
    // rows forever — force a full frame so ghosts cannot stack above the input.
    this.prevLines = null;
    this.paint();
  }

  setOverlay(lines: readonly string[]): void {
    this.overlayLines = lines;

    if (this.entered) {
      this.paint();
    }
  }

  clearOverlay(): void {
    if (this.overlayLines.length === 0) {
      return;
    }

    this.overlayLines = [];

    if (this.entered) {
      this.paint();
    }
  }

  setAgentTree(lines: readonly string[]): void {
    this.agentTreeLines = lines;

    if (this.entered) {
      this.paint();
    }
  }

  clearAgentTree(): void {
    if (this.agentTreeLines.length === 0) {
      return;
    }

    this.agentTreeLines = [];

    if (this.entered) {
      this.paint();
    }
  }

  setInput(input: IPaneInput): void {
    const prevInner = this.draftInnerRows();

    this.input = {
      lines: [...input.lines],
      cursorRow: input.cursorRow,
      cursorCol: input.cursorCol,
    };

    if (!this.entered) {
      return;
    }

    // Growing/shrinking the box moves the body/input split — full paint.
    if (this.draftInnerRows() !== prevInner) {
      this.geometryDirty = true;
      this.prevLines = null;
      this.paint();

      return;
    }

    // Keystroke hot path: only the input band changes. A full paint re-walks
    // scrollback/wrap and was the lag source behind every space/character.
    if (this.prevLines !== null && !this.geometryDirty) {
      this.paintInputOnly();

      return;
    }

    this.paint();
  }

  /** Patch just the input band + caret — skips scrollback wrap/compose. */
  private paintInputOnly(): void {
    const insets = outerInsets(this.rows, this.cols);
    const layout = computeLayout(this.layoutOpts());
    const band = this.paintInputBand(layout);
    const screen = this.prevLines;

    if (screen === null) {
      this.paint();

      return;
    }

    const gutter = paint(
      GUTTER,
      this.focus.panelFocused ? CONSOLE.bright : CONSOLE.rule,
      true
    );
    const panelSource = this.panelPaintLines();
    const panelStart = layout.main.rows;
    let dirty = "";

    for (let i = 0; i < layout.input.rows; i += 1) {
      const row = insets.originRow + layout.input.row + i;
      const mainCols =
        layout.panel !== null ? layout.main.cols : insets.contentCols;
      const mainLine = fitAnsiLine(band.lines[i] ?? "", mainCols);
      const content =
        layout.panel !== null
          ? paintSplitRow(
              mainLine,
              gutter,
              insetX(panelSource[panelStart + i] ?? "", layout.panel.cols)
            )
          : mainLine;
      const line = frameContentRow(content, this.cols);
      const stamped = withOpaqueBg(line, CONSOLE.bg);

      if (screen[row] !== stamped) {
        screen[row] = stamped;
        dirty +=
          cup(row + 1, 1) +
          lastRowSafe(stamped, row, this.rows, this.cols) +
          EL_EOL;
      }
    }

    const cursorRow =
      insets.originRow + layout.input.row + band.cursor.row + 1;
    const cursorCol =
      insets.originCol + layout.input.col + band.cursor.col + 1;

    this.cursor.reset();
    const cursorBytes = this.cursor.move(cursorRow, cursorCol);

    if (dirty.length > 0) {
      this.out.write(BEGIN_SYNC + dirty + cursorBytes + END_SYNC);
    } else {
      this.out.write(BEGIN_SYNC + cursorBytes + END_SYNC);
    }
  }

  dumpTranscript(): string {
    return this.scrollback.dump();
  }

  handleKey(seq: string): PaneKeyResult {
    if (seq === "\x0f") {
      return "dump";
    }

    const deps = {
      focus: this.focus,
      scrollback: this.scrollback,
      panelLen: this.panelSourceLen(),
      onWheel: (delta: number, col: number, _row: number): void => {
        this.wheelAt(delta, col);
      },
      paint: () => {
        this.paint();
      },
      invalidate: () => {
        this.prevLines = null;
      },
    };

    return (
      handleFocusKey(seq, deps) ??
      handleScrollKey(seq, deps) ??
      handleMouseKey(seq, deps) ??
      "passthrough"
    );
  }

  /** Wheel over panel columns scrolls the rail; otherwise the main transcript. */
  private wheelAt(delta: number, col1Based: number): void {
    const insets = outerInsets(this.rows, this.cols);
    const layout = computeLayout(this.layoutOpts());
    // Mouse cols are terminal-absolute; layout cols are content-relative.
    const contentCol = col1Based - insets.originCol;
    const overPanel =
      layout.panel !== null && contentCol > layout.main.cols + 1;

    if (overPanel) {
      // Wheel up (positive delta from handler) → earlier lines → decrease offset.
      this.panelOffset = Math.max(0, this.panelOffset - delta);
      this.clampPanelOffset();

      return;
    }

    this.scrollback.scroll(delta);
  }

  private panelSourceLen(): number {
    return this.panelBodyLines().length;
  }

  /** Body rows available under the sticky Tasks title + under-rule. */
  private panelBodyViewRows(): number {
    return Math.max(0, this.bodyViewportRows - RAIL_TITLE_ROWS);
  }

  private clampPanelOffset(): void {
    const max = Math.max(0, this.panelSourceLen() - this.panelBodyViewRows());

    if (this.panelOffset > max) {
      this.panelOffset = max;
    }
  }

  /**
   * Columns available for transcript / bubble content inside the main pane
   * (after horizontal inset). Callers must size user/agent chrome to this —
   * full `stdout.columns` is wider than the pane and causes mid-word rewrap.
   */
  mainInnerCols(): number {
    const layout = computeLayout(this.layoutOpts());

    return insetInnerCols(layout.main.cols);
  }

  paint(): void {
    if (!this.entered) {
      return;
    }

    const layout = computeLayout(this.layoutOpts());
    const inputBand = this.paintInputBand(layout);
    const topLines = this.composeTop(layout);

    this.lastTopLine = topLines.join("\n");

    if (this.flashHeaderPaints > 0) {
      this.flashHeaderPaints -= 1;
    }

    const bodyHeader = Math.min(BODY_HEADER_ROWS, layout.main.rows);
    const bodyBudget = Math.max(0, layout.main.rows - bodyHeader);
    const bodyGap = bodyBudget >= BODY_GAP_ROWS + 2 ? BODY_GAP_ROWS : 0;
    const chromeAll = [...this.agentTreeLines, ...this.overlayLines];
    const scrollBudget = Math.max(0, bodyBudget - bodyGap);
    const chromeRows = Math.min(chromeAll.length, Math.max(0, scrollBudget - 1));
    const mainRows = scrollBudget - chromeRows;
    const wrapCols = insetInnerCols(layout.main.cols);

    this.bodyViewportRows = mainRows;
    this.clampPanelOffset();
    this.applyScrollbackViewport(wrapCols, mainRows);

    const content = this.composeScreen({
      layout,
      topLines,
      inputBand,
      bodyHeader,
      bodyGap,
      mainRows,
      chromeRows,
      chrome: chromeAll.slice(chromeAll.length - chromeRows),
    });
    const insets = outerInsets(this.rows, this.cols);
    const screen = wrapOuterFrame(content, this.rows, this.cols, {
      splitCol: layout.panel !== null ? layout.main.cols : undefined,
    }).map((line) => withOpaqueBg(line, CONSOLE.bg));

    this.flushScreen(screen, {
      inputStart: insets.originRow + layout.input.row,
      cursor: inputBand.cursor,
      inputCol: insets.originCol + layout.input.col,
    });
  }

  private railCounts(): { done: number; total: number } {
    const badge = this.worklistBadge.trim();
    const fromBadge = /^(\d+)\/(\d+)$/.exec(badge);

    if (fromBadge !== null) {
      return {
        done: Number(fromBadge[1]),
        total: Number(fromBadge[2]),
      };
    }

    const head = stripSgr(this.panelLines[0] ?? "");
    const fromHead = /^worklist\s+(\d+)\/(\d+)/.exec(head);

    if (fromHead !== null) {
      return {
        done: Number(fromHead[1]),
        total: Number(fromHead[2]),
      };
    }

    return { done: 0, total: 0 };
  }

  private topbarLines(
    cols: number,
    layout: ReturnType<typeof computeLayout>
  ): string[] {
    const counts = this.railCounts();
    const rawBadge =
      this.worklistBadge.length > 0
        ? this.worklistBadge
        : `${String(counts.done)}/${String(counts.total)}`;
    const badge =
      this.flashHeaderPaints > 0
        ? paint(rawBadge, CONSOLE.bright, true)
        : rawBadge;

    return formatConsoleTopbar({
      info: this.status,
      cwd: this.cwd,
      sessionId: this.sessionId,
      worklistBadge: badge,
      cols,
      splitCol: layout.panel !== null ? layout.main.cols : undefined,
      padTop: layout.top.rows >= TOP_STATUS_ROWS,
    });
  }

  private composeTop(layout: ReturnType<typeof computeLayout>): string[] {
    if (layout.top.rows <= 0) {
      return [];
    }

    const lines = this.topbarLines(layout.top.cols, layout);

    while (lines.length < layout.top.rows) {
      lines.push("");
    }

    return lines.slice(0, layout.top.rows);
  }

  private applyScrollbackViewport(cols: number, mainRows: number): void {
    if (cols !== this.lastWrapCols) {
      this.scrollback.reflow(cols);
      this.lastWrapCols = cols;
    } else {
      this.scrollback.setWrapCols(cols);
    }

    this.scrollback.setViewportRows(mainRows);
  }

  private composeScreen(opts: {
    layout: ReturnType<typeof computeLayout>;
    topLines: string[];
    inputBand: {
      lines: string[];
      cursor: { row: number; col: number };
    };
    bodyHeader: number;
    bodyGap: number;
    mainRows: number;
    chromeRows: number;
    chrome: string[];
  }): string[] {
    const { layout } = opts;
    const contentCols = layout.top.cols;
    const contentRows = Math.max(
      1,
      layout.footer.row + layout.footer.rows
    );
    const screen: string[] = new Array<string>(contentRows);
    const mainVisible = this.scrollback.visible();
    const panelCols = layout.panel?.cols ?? 0;
    const panelSource =
      layout.panel !== null ? this.panelPaintLines(panelCols) : [];
    // Same ink as horizontal hairlines — dim SGR reads as a different grey.
    const gutter = paint(
      GUTTER,
      this.focus.panelFocused ? CONSOLE.bright : CONSOLE.rule,
      true
    );

    for (let i = 0; i < layout.top.rows; i += 1) {
      screen[layout.top.row + i] = fitAnsiLine(
        opts.topLines[i] ?? "",
        contentCols
      );
    }

    const gapStart = layout.main.row + opts.bodyHeader;

    for (let g = 0; g < opts.bodyGap; g += 1) {
      screen[gapStart + g] = paintSplitRow(
        fitAnsiLine("", layout.panel !== null ? layout.main.cols : contentCols),
        gutter,
        layout.panel !== null ? fitAnsiLine("", layout.panel.cols) : null
      );
    }

    const bodyStart = gapStart + opts.bodyGap;
    const mainCols = layout.panel !== null ? layout.main.cols : contentCols;
    // Grok-style overflow track in the right inset pad (no wrap-width steal).
    const scrollbar = formatScrollbarColumn(
      this.scrollback.metrics(),
      opts.mainRows,
      true
    );

    for (let r = 0; r < opts.mainRows; r += 1) {
      const idx = bodyStart + r;
      let main = insetX(mainVisible[r] ?? "", mainCols);
      // Track cells are blank (same as the inset pad) — only stamp the thumb.
      const thumb = scrollbar?.[r];

      if (thumb !== undefined && thumb !== " ") {
        main = overlayScrollbarCol(main, mainCols, thumb);
      }

      const panelCell =
        layout.panel !== null
          ? fitPanelCell(panelSource[r] ?? "", layout.panel.cols)
          : null;
      // Under-rule under Tasks: `├` joins the gutter spine to the panel ─.
      const splitGutter =
        panelCell !== null && isRailUnderRule(panelCell)
          ? paint(
              "├",
              this.focus.panelFocused ? CONSOLE.bright : CONSOLE.rule,
              true
            )
          : gutter;

      // Each slot is hard-clamped to its column budget — content must never
      // overwrite the panel gutter or bleed past the main pane.
      screen[idx] =
        layout.panel !== null
          ? paintSplitRow(main, splitGutter, panelCell)
          : main;
    }

    // Overlay / agent-tree chrome shares the main column — never full-bleed
    // across the panel gutter (menus used to punch through the side rail).
    for (let i = 0; i < opts.chromeRows; i += 1) {
      const r = opts.mainRows + i;
      const idx = bodyStart + r;

      screen[idx] =
        layout.panel !== null
          ? paintSplitRow(
              insetX(opts.chrome[i] ?? "", layout.main.cols),
              gutter,
              fitPanelCell(panelSource[r] ?? "", layout.panel.cols)
            )
          : insetX(opts.chrome[i] ?? "", contentCols);
    }

    // Input + bottom air keep the panel gutter spine (┬ → │ → bottom).
    const inputMainCols = layout.panel !== null ? layout.main.cols : contentCols;
    const spineBase = opts.mainRows + opts.chromeRows;

    for (let i = 0; i < layout.input.rows; i += 1) {
      const mainLine = fitAnsiLine(
        opts.inputBand.lines[i] ?? "",
        inputMainCols
      );

      screen[layout.input.row + i] =
        layout.panel !== null
          ? paintSplitRow(
              mainLine,
              gutter,
              fitPanelCell(panelSource[spineBase + i] ?? "", layout.panel.cols)
            )
          : mainLine;
    }

    for (let i = 0; i < layout.footer.rows; i += 1) {
      const idx = layout.footer.row + i;
      const spineIdx = spineBase + layout.input.rows + i;

      screen[idx] =
        layout.panel !== null
          ? paintSplitRow(
              fitAnsiLine("", layout.main.cols),
              gutter,
              fitPanelCell(panelSource[spineIdx] ?? "", layout.panel.cols)
            )
          : fitAnsiLine("", contentCols);
    }

    for (let r = 0; r < contentRows; r += 1) {
      screen[r] ??= fitAnsiLine("", contentCols);
    }

    return screen;
  }

  private flushScreen(
    screen: string[],
    opts: {
      inputStart: number;
      cursor: { row: number; col: number };
      inputCol: number;
    }
  ): void {
    let dirty = "";

    if (this.geometryDirty) {
      dirty += CLEAR_SCREEN;
      this.geometryDirty = false;
      this.prevLines = null;
    }

    for (let r = 0; r < this.rows; r += 1) {
      const line = screen[r] ?? fitAnsiLine("", this.cols);

      if (this.prevLines?.[r] !== line) {
        dirty +=
          cup(r + 1, 1) + lastRowSafe(line, r, this.rows, this.cols) + EL_EOL;
      }
    }

    const cursorRow = opts.inputStart + opts.cursor.row + 1;
    const cursorCol = opts.inputCol + opts.cursor.col + 1;

    // Row paints leave the hardware cursor at the end of the last dirty line.
    // Force a CUP after any dirty write so CursorState dedupe cannot strand it
    // on the footer. Pure no-op paints (no dirty) write nothing.
    if (dirty.length > 0) {
      this.cursor.reset();
      const cursorBytes = this.cursor.move(cursorRow, cursorCol);

      this.out.write(BEGIN_SYNC + dirty + cursorBytes + END_SYNC);
    }

    this.prevLines = screen;
  }

  /** Re-home the caret onto the input row (e.g. after prompt() with no dirty rows). */
  rehomeCursor(): void {
    if (!this.entered) {
      return;
    }

    const insets = outerInsets(this.rows, this.cols);
    const layout = computeLayout(this.layoutOpts());
    const band = this.paintInputBand(layout);
    const cursorRow =
      insets.originRow + layout.input.row + band.cursor.row + 1;
    const cursorCol =
      insets.originCol + layout.input.col + band.cursor.col + 1;

    this.cursor.reset();
    this.out.write(
      BEGIN_SYNC + this.cursor.move(cursorRow, cursorCol) + END_SYNC
    );
  }

  /**
   * Panel column lines for the body viewport: sticky Tasks title + under-rule,
   * then the scrolled item list. Title stays put while the body scrolls.
   */
  private panelPaintLines(panelCols: number): string[] {
    const counts = this.railCounts();
    const title = formatRailTitleBlock({
      done: counts.done,
      total: counts.total,
      cols: panelCols,
      color: true,
    });
    const raw = this.panelBodyLines();
    const view = this.panelBodyViewRows();
    const slice = raw.slice(this.panelOffset, this.panelOffset + view);

    if (!this.focus.panelFocused) {
      return [...title, ...slice.map((l) => paint(l, STYLE.dim, true))];
    }

    const body = slice.map((line, i) => {
      const abs = this.panelOffset + i;

      return abs === this.focus.selection
        ? paint(`▸ ${stripSgr(line)}`, CONSOLE.bright, true)
        : `  ${line}`;
    });

    return [...title, ...body];
  }

  /** Rail body lines — skip the legacy `worklist N/M` header (Tasks title owns it). */
  private panelBodyLines(): string[] {
    if (this.panelLines.length === 0) {
      return [...EMPTY_PANEL_LINES];
    }

    const head = stripSgr(this.panelLines[0] ?? "");

    if (head === "worklist" || /^worklist\s+\d+\/\d+/.test(head)) {
      const rest = this.panelLines.slice(1);

      return rest.length > 0 ? [...rest] : [...EMPTY_PANEL_LINES];
    }

    return [...this.panelLines];
  }

  /**
   * Closed input box aligned to the agent/user card:
   * same left inset and width as `mainInnerCols()` (not full-bleed).
   * Grows with draft visual lines (capped); Enter clears → 1 mid row again.
   *   ╭────╮
   *   │ >  │
   *   ╰────╯
   */
  private paintInputBand(layout: ReturnType<typeof computeLayout>): {
    lines: string[];
    cursor: { row: number; col: number };
  } {
    const inner = this.draftInnerRows();
    const wantedBand = inputBandRows(inner);
    const bandRows = Math.max(1, Math.min(layout.input.rows, wantedBand));
    const lines = this.input.lines.length > 0 ? this.input.lines : [""];
    const cursorRow = Math.max(
      0,
      Math.min(this.input.cursorRow, lines.length - 1)
    );
    // Editor already windows to INPUT_INNER_ROWS_MAX — take what it gave us.
    const draftLines = lines.slice(0, inner);
    const emptyDraft =
      draftLines.length === 1 &&
      (draftLines[0] ?? "").length === 0 &&
      this.focus.promptFocused;
    const label = formatInputStatusLabel(this.status);
    // Match AGENT/USER card width inside the main pane.
    const pad = CHROME_PAD_X;
    const boxCols = Math.max(8, insetInnerCols(layout.main.cols, pad));
    const box = formatInputBox({
      cols: boxCols,
      draftLines: emptyDraft ? [""] : draftLines,
      placeholder: FORGE_PLACEHOLDER,
      label,
      color: true,
      showPlaceholder: emptyDraft,
    });
    let painted = [...box.lines];

    // Short terminals may clip the closed box — keep the mid+caret visible.
    if (painted.length > bandRows) {
      if (bandRows >= 2) {
        painted = painted.slice(0, bandRows - 1);
        painted.push(box.lines[box.lines.length - 1] ?? "");
      } else {
        painted = painted.slice(1, 1 + bandRows);
      }
    }

    while (painted.length < bandRows) {
      painted.push(fitAnsiLine("", boxCols));
    }

    const midRow = bandRows >= 3 ? 1 + cursorRow : Math.min(cursorRow, bandRows - 1);
    const left = " ".repeat(pad);
    // Main-column width only — compose stamps the gutter + panel beside us.
    const band = painted.map((row) =>
      fitAnsiLine(`${left}${row}`, layout.main.cols)
    );

    return {
      lines: band.slice(0, bandRows),
      cursor: {
        row: Math.min(midRow, bandRows - 1),
        col: pad + inputCursorCol(this.input.cursorCol),
      },
    };
  }
}

/** main │ panel — gutter column is the continuous frame spine. */
function paintSplitRow(
  main: string,
  gutter: string,
  panel: string | null
): string {
  if (panel === null) {
    return main;
  }

  return `${main}${gutter}${panel}`;
}

/**
 * Panel cells: sticky title/rule are already sized to `cols` — don't double
 * inset (that clipped the right-hand count). Body lines still get insetX.
 */
function fitPanelCell(line: string, cols: number): string {
  if (cols <= 0) {
    return "";
  }

  if (displayWidth(stripSgr(line)) === cols) {
    return fitAnsiLine(line, cols);
  }

  return insetX(line, cols);
}

/** Sticky Tasks under-rule — full panel width of `─` (joins via `├`/`┤`). */
function isRailUnderRule(panelCell: string): boolean {
  const plain = stripSgr(panelCell);

  return plain.length > 0 && /^─+$/u.test(plain);
}

/**
 * Writing into the bottom-right cell wraps the alt screen (xterm etc.), scrolling
 * the frame and parking the cursor on a phantom row under the footer. Keep the
 * last row at most `cols - 1` wide; EL_EOL clears the final cell.
 */
function lastRowSafe(
  fittedLine: string,
  row: number,
  rows: number,
  cols: number
): string {
  if (row !== rows - 1 || cols <= 1) {
    return fittedLine;
  }

  if (displayWidth(stripSgr(fittedLine)) < cols) {
    return fittedLine;
  }

  // fitAnsiLine pads with trailing spaces — drop one to free the corner cell.
  if (fittedLine.endsWith(" ")) {
    return fittedLine.slice(0, -1);
  }

  return fitAnsiLine(fittedLine, cols - 1);
}
