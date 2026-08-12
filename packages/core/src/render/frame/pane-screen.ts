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
import { parseWorklistBadge } from "../../loop/worklist/panel";
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
import { paint } from "../style";
import { displayWidth } from "../width";
import { formatScrollbarColumn, overlayScrollbarCol } from "./scrollbar";
import { frameContentRow, outerInsets, wrapOuterFrame } from "./outer-frame";

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
/** Fallback when no worklist lines are set — mirrors formatWorklistLines empty. */
const EMPTY_PANEL_LINES = ["approve a plan", "to fill this list"] as const;

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
  /** Mode/badge/cwd/status-class — full invalidate when this changes, not on ticks. */
  private lastTopShape = "";
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
  /** Coalesced wheel delta (positive = older / up) awaiting setImmediate paint. */
  private wheelAccum = 0;
  private wheelCol = 1;
  private wheelPaintQueued = false;
  private bodyViewportRows = 1;
  private entered = false;
  /** True after a successful enter — resize may re-enter after a shrink-leave. */
  private everEntered = false;
  private rows: number;
  private cols: number;
  /** Turn in flight — chrome stays interactive; timer keeps status paint alive. */
  private busy = false;
  private busyTimer: ReturnType<typeof setInterval> | null = null;
  /** Optional tick while busy (REPL wires syncPaneChrome). */
  onBusyTick: (() => void) | null = null;
  /** Fired when Ctrl+G changes main/panel width — resize the prompt editor. */
  onLayoutChange: (() => void) | null = null;

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

  get isBusy(): boolean {
    return this.busy;
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

    this.stopBusyTimer();
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

  /**
   * Apply a new terminal size. When `paint` is false, only updates geometry —
   * caller must paint once (e.g. after syncing status) so resize settle is a
   * single frame, not resize-paint + setStatus-paint.
   */
  resize(
    rows: number,
    cols: number,
    opts?: { readonly paint?: boolean }
  ): void {
    const nextRows = Math.max(1, rows);
    const nextCols = Math.max(1, cols);
    const geomChanged = nextRows !== this.rows || nextCols !== this.cols;
    const shouldPaint = opts?.paint !== false;

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

    if (shouldPaint) {
      this.paint();
    }
  }

  appendMain(text: string): void {
    this.scrollback.append(text);

    if (!this.entered) {
      return;
    }

    // Streaming hot path: following + no overlay — patch main viewport only.
    if (
      this.prevLines !== null &&
      !this.geometryDirty &&
      this.scrollback.following &&
      this.overlayLines.length === 0 &&
      this.agentTreeLines.length === 0 &&
      this.lastWrapCols > 0
    ) {
      this.paintMainFollowOnly();

      return;
    }

    this.paint();
  }

  setPanel(lines: readonly string[], opts?: { readonly soft?: boolean }): void {
    this.panelLines = lines;
    this.focus.syncHasItems(this.hasPanelContent());
    this.clampPanelOffset();

    if (this.entered) {
      // Soft = body patch only (spinner ticks on the current-task mark).
      if (opts?.soft === true) {
        this.paintAfterScroll();
      } else {
        this.paint();
      }
    }
  }

  /** Scroll the main transcript viewport (positive = older). */
  scrollMain(delta: number): void {
    this.scrollback.scroll(delta);

    if (this.entered) {
      this.paintAfterScroll();
    }
  }

  /** Scroll the side panel list (positive = later lines). */
  scrollPanel(delta: number): void {
    this.panelOffset = Math.max(0, this.panelOffset + delta);
    this.clampPanelOffset();

    if (this.entered) {
      this.paintAfterScroll();
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
      head === "approve a plan" ||
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
      // Visible unless the user hid it (Ctrl+G). Empty landing still shows the
      // Tasks chrome; focus.panel may be "hidden" when there are no items.
      showPanel: !this.focus.userCollapsed,
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

    const shapeChanged = badge !== this.worklistBadge;

    this.lastBadge = badge;
    this.worklistBadge = badge;

    if (shapeChanged) {
      this.lastTopShape = "";
      this.prevLines = null;
    }

    if (this.entered) {
      this.paint();
    }
  }

  setBusy(busy: boolean): void {
    this.busy = busy;

    if (busy) {
      this.startBusyTimer();
    } else {
      this.stopBusyTimer();
    }

    if (this.entered) {
      this.paint();
    }
  }

  private startBusyTimer(): void {
    if (this.busyTimer !== null) {
      return;
    }

    // Keep chrome alive while a turn awaits (gate, model, tools) — even when
    // child streams are silent. REPL's onBusyTick refreshes status activity.
    this.busyTimer = setInterval(() => {
      this.onBusyTick?.();
    }, 250);
  }

  private stopBusyTimer(): void {
    if (this.busyTimer === null) {
      return;
    }

    clearInterval(this.busyTimer);
    this.busyTimer = null;
  }

  /** Identity chips for the pinned topbar (cwd + short session id). */
  setHeader(opts: { cwd: string; sessionId?: string }): void {
    this.cwd = opts.cwd;
    this.sessionId = opts.sessionId ?? "";
    this.lastTopShape = "";

    if (this.entered) {
      this.prevLines = null;
      this.paint();
    }
  }

  /**
   * Update the top-strip status. Routine ticks (activity / elapsed) differential-
   * paint dirty top rows only. Shape changes (mode, badge, cwd, status class)
   * full-invalidate so chrome width shifts cannot leave ghosts.
   */
  setStatus(info: IStatusInfo, opts?: { readonly paint?: boolean }): void {
    this.status = info;

    if (!this.entered) {
      return;
    }

    const layout = computeLayout(this.layoutOpts());
    const nextTop =
      layout.top.rows > 0
        ? this.topbarLines(layout.top.cols, layout).join("\n")
        : "";
    const nextShape = this.topStripShape(info);

    if (
      nextTop === this.lastTopLine &&
      nextShape === this.lastTopShape &&
      this.prevLines !== null &&
      this.flashHeaderPaints === 0
    ) {
      return;
    }

    if (nextShape !== this.lastTopShape) {
      this.lastTopShape = nextShape;
      this.prevLines = null;
    }

    if (opts?.paint === false) {
      return;
    }

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

  /**
   * Stable top-strip shape — mode/badge/cwd/status class, not ticking activity
   * text. Shape changes full-invalidate; ticks differential-paint.
   */
  private topStripShape(info: IStatusInfo): string {
    const hasActivity =
      info.activity !== undefined && info.activity.length > 0 ? "a" : "s";

    return [
      info.mode ?? "",
      info.status,
      info.model,
      info.scope,
      this.worklistBadge,
      this.cwd,
      hasActivity,
    ].join("\0");
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
    const panelCols = layout.panel?.cols ?? 0;
    const panelSource =
      layout.panel !== null ? this.panelPaintLines(panelCols) : [];
    const panelStart = layout.main.rows;
    const splitCol = layout.panel !== null ? layout.main.cols : undefined;
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
              fitPanelCell(panelSource[panelStart + i] ?? "", panelCols)
            )
          : mainLine;
      const line = frameContentRow(content, this.cols, { splitCol });
      const stamped = withOpaqueBg(line, CONSOLE.bg);

      if (screen[row] !== stamped) {
        screen[row] = stamped;
        dirty +=
          cup(row + 1, 1) +
          lastRowSafe(stamped, row, this.rows, this.cols) +
          EL_EOL;
      }
    }

    const cursorRow = insets.originRow + layout.input.row + band.cursor.row + 1;
    const cursorCol = insets.originCol + layout.input.col + band.cursor.col + 1;

    this.cursor.reset();
    const cursorBytes = this.cursor.move(cursorRow, cursorCol);

    if (dirty.length > 0) {
      this.out.write(BEGIN_SYNC + dirty + cursorBytes + END_SYNC);
    } else {
      this.out.write(BEGIN_SYNC + cursorBytes + END_SYNC);
    }
  }

  /**
   * Streaming hot path: refresh main viewport (+ scrollbar) while following.
   * Reuses top/input/panel from prevLines — no full compose/outer-frame rebuild.
   */
  private paintMainFollowOnly(): void {
    const screen = this.prevLines;

    if (screen === null) {
      this.paint();

      return;
    }

    const insets = outerInsets(this.rows, this.cols);
    const layout = computeLayout(this.layoutOpts());
    const bodyGap = layout.main.rows >= BODY_GAP_ROWS + 2 ? BODY_GAP_ROWS : 0;
    const mainRows = Math.max(0, layout.main.rows - bodyGap);
    const wrapCols = insetInnerCols(layout.main.cols);

    if (wrapCols !== this.lastWrapCols || mainRows !== this.bodyViewportRows) {
      this.paint();

      return;
    }

    this.scrollback.setViewportRows(mainRows);
    const band = this.paintInputBand(layout);
    const dirty = this.patchMainViewportRows(screen, {
      layout,
      insets,
      mainRows,
      bodyStart: layout.main.row + bodyGap,
      mainVisible: this.scrollback.visible(),
      scrollbar: formatScrollbarColumn(
        this.scrollback.metrics(),
        mainRows,
        true
      ),
    });

    if (dirty.length === 0) {
      return;
    }

    const cursorRow = insets.originRow + layout.input.row + band.cursor.row + 1;
    const cursorCol = insets.originCol + layout.input.col + band.cursor.col + 1;

    this.cursor.reset();
    this.out.write(
      BEGIN_SYNC + dirty + this.cursor.move(cursorRow, cursorCol) + END_SYNC
    );
  }

  /** Patch main-body terminal rows in `screen`; returns CSI dirty bytes. */
  private patchMainViewportRows(
    screen: string[],
    opts: {
      readonly layout: ReturnType<typeof computeLayout>;
      readonly insets: ReturnType<typeof outerInsets>;
      readonly mainRows: number;
      readonly bodyStart: number;
      readonly mainVisible: readonly string[];
      readonly scrollbar: readonly string[] | null;
    }
  ): string {
    const { layout, insets, mainRows, bodyStart, mainVisible, scrollbar } =
      opts;
    const mainCols = layout.panel !== null ? layout.main.cols : layout.top.cols;
    const gutter = paint(
      GUTTER,
      this.focus.panelFocused ? CONSOLE.bright : CONSOLE.rule,
      true
    );
    const panelCols = layout.panel?.cols ?? 0;
    const panelSource =
      layout.panel !== null ? this.panelPaintLines(panelCols) : [];
    const splitCol = layout.panel !== null ? layout.main.cols : undefined;
    const ruleGutter = paint(
      "├",
      this.focus.panelFocused ? CONSOLE.bright : CONSOLE.rule,
      true
    );
    let dirty = "";

    for (let r = 0; r < mainRows; r += 1) {
      const content = buildMainSplitContent({
        mainText: mainVisible[r] ?? "",
        mainCols,
        thumb: scrollbar?.[r],
        gutter,
        ruleGutter,
        panelCell:
          layout.panel !== null
            ? fitPanelCell(panelSource[r] ?? "", panelCols)
            : null,
      });
      const stamped = withOpaqueBg(
        frameContentRow(content, this.cols, { splitCol }),
        CONSOLE.bg
      );
      const termRow = insets.originRow + bodyStart + r;

      if (screen[termRow] !== stamped) {
        screen[termRow] = stamped;
        dirty +=
          cup(termRow + 1, 1) +
          lastRowSafe(stamped, termRow, this.rows, this.cols) +
          EL_EOL;
      }
    }

    return dirty;
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
        this.queueWheel(delta, col);
      },
      onLayoutChange: (): void => {
        this.onLayoutChange?.();
      },
      paint: () => {
        // Ctrl+G changes main width — always full compose after invalidate.
        if (this.prevLines === null || this.geometryDirty) {
          this.paint();
        } else {
          this.paintAfterScroll();
        }
      },
      invalidate: () => {
        this.prevLines = null;
        this.geometryDirty = true;
        this.lastWrapCols = 0;
      },
    };

    return (
      handleFocusKey(seq, deps) ??
      handleScrollKey(seq, deps) ??
      handleMouseKey(seq, deps) ??
      "passthrough"
    );
  }

  /**
   * Coalesce trackpad wheel floods into one scroll+paint on the next
   * immediate turn — otherwise each notch rebuilds the body.
   */
  private queueWheel(delta: number, col1Based: number): void {
    this.wheelAccum += delta;
    this.wheelCol = col1Based;

    if (this.wheelPaintQueued) {
      return;
    }

    this.wheelPaintQueued = true;
    setImmediate(() => {
      this.wheelPaintQueued = false;
      const d = this.wheelAccum;

      this.wheelAccum = 0;

      if (d === 0 || !this.entered) {
        return;
      }

      this.applyWheel(d, this.wheelCol);
      this.paintAfterScroll();
    });
  }

  /** Wheel over panel columns scrolls the rail; otherwise the main transcript. */
  private applyWheel(delta: number, col1Based: number): void {
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

  /**
   * Scroll / focus paint: patch main+panel body when the frame cache is warm.
   * Full compose only when geometry/overlay forces it — never null prevLines
   * just because the viewport moved.
   */
  private paintAfterScroll(): void {
    if (!this.entered) {
      return;
    }

    if (
      this.prevLines !== null &&
      !this.geometryDirty &&
      this.overlayLines.length === 0 &&
      this.agentTreeLines.length === 0 &&
      this.lastWrapCols > 0
    ) {
      this.paintMainFollowOnly();

      return;
    }

    this.paint();
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

  /**
   * Wrap budget for Tasks-rail body lines (0 when collapsed).
   * Matches {@link fitPanelCell}'s insetX — full panel.cols over-wraps and
   * mid-word clips (and strips SGR) when painted.
   */
  panelInnerCols(): number {
    const layout = computeLayout(this.layoutOpts());

    if (layout.panel === null) {
      return 0;
    }

    return insetInnerCols(layout.panel.cols);
  }

  /** Rows available for checklist body under the sticky Tasks title. */
  panelListBudgetRows(): number {
    return this.panelBodyViewRows();
  }

  /**
   * Max rows an overlay may occupy in the main pane body (leaves one transcript
   * row). Menu formatters should fit this budget so pinOverlayChrome is only a
   * safety net.
   */
  overlayBudgetRows(): number {
    const layout = computeLayout(this.layoutOpts());
    const bodyGap = layout.main.rows >= BODY_GAP_ROWS + 2 ? BODY_GAP_ROWS : 0;
    const scrollBudget = Math.max(0, layout.main.rows - bodyGap);

    return Math.max(1, scrollBudget - 1);
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

    const bodyGap = layout.main.rows >= BODY_GAP_ROWS + 2 ? BODY_GAP_ROWS : 0;
    const chromeAll = [...this.agentTreeLines, ...this.overlayLines];
    const scrollBudget = Math.max(0, layout.main.rows - bodyGap);
    const chromeRows = Math.min(
      chromeAll.length,
      Math.max(0, scrollBudget - 1)
    );
    const mainRows = scrollBudget - chromeRows;
    const wrapCols = insetInnerCols(layout.main.cols);

    this.bodyViewportRows = mainRows;
    this.clampPanelOffset();
    this.applyScrollbackViewport(wrapCols, mainRows);

    const content = this.composeScreen({
      layout,
      topLines,
      inputBand,
      bodyGap,
      mainRows,
      chromeRows,
      // Pin the first overlay line (menu title) when the menu is taller than
      // the chrome budget — otherwise /help's title was scrolled off forever.
      chrome: pinOverlayChrome(chromeAll, chromeRows),
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
    const fromBadge = parseWorklistBadge(this.worklistBadge);

    if (fromBadge.total > 0) {
      return fromBadge;
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
    return formatConsoleTopbar({
      info: this.status,
      cwd: this.cwd,
      sessionId: this.sessionId,
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
    bodyGap: number;
    mainRows: number;
    chromeRows: number;
    chrome: string[];
  }): string[] {
    const { layout } = opts;
    const contentCols = layout.top.cols;
    const contentRows = Math.max(1, layout.footer.row + layout.footer.rows);
    const screen: string[] = new Array<string>(contentRows);
    const mainVisible = this.scrollback.visible();
    const panelCols = layout.panel?.cols ?? 0;
    const panelSource =
      layout.panel !== null ? this.panelPaintLines(panelCols) : [];
    const gutter = paint(
      GUTTER,
      this.focus.panelFocused ? CONSOLE.bright : CONSOLE.rule,
      true
    );
    const ruleGutter = paint(
      "├",
      this.focus.panelFocused ? CONSOLE.bright : CONSOLE.rule,
      true
    );

    for (let i = 0; i < layout.top.rows; i += 1) {
      screen[layout.top.row + i] = fitAnsiLine(
        opts.topLines[i] ?? "",
        contentCols
      );
    }

    const gapStart = layout.main.row;

    for (let g = 0; g < opts.bodyGap; g += 1) {
      screen[gapStart + g] = paintSplitRow(
        fitAnsiLine("", layout.panel !== null ? layout.main.cols : contentCols),
        gutter,
        layout.panel !== null ? fitAnsiLine("", panelCols) : null
      );
    }

    const bodyStart = gapStart + opts.bodyGap;
    const mainCols = layout.panel !== null ? layout.main.cols : contentCols;
    const scrollbar = formatScrollbarColumn(
      this.scrollback.metrics(),
      opts.mainRows,
      true
    );

    for (let r = 0; r < opts.mainRows; r += 1) {
      screen[bodyStart + r] = buildMainSplitContent({
        mainText: mainVisible[r] ?? "",
        mainCols,
        thumb: scrollbar?.[r],
        gutter,
        ruleGutter,
        panelCell:
          layout.panel !== null
            ? fitPanelCell(panelSource[r] ?? "", panelCols)
            : null,
      });
    }

    this.fillSplitChrome(screen, {
      layout,
      gutter,
      panelSource,
      panelCols,
      contentCols,
      bodyStart,
      mainRows: opts.mainRows,
      chromeRows: opts.chromeRows,
      chrome: opts.chrome,
      inputBand: opts.inputBand,
    });

    for (let r = 0; r < contentRows; r += 1) {
      screen[r] ??= fitAnsiLine("", contentCols);
    }

    return screen;
  }

  /** Overlay/input/footer rows that share the panel gutter spine. */
  private fillSplitChrome(
    screen: string[],
    opts: {
      readonly layout: ReturnType<typeof computeLayout>;
      readonly gutter: string;
      readonly panelSource: readonly string[];
      readonly panelCols: number;
      readonly contentCols: number;
      readonly bodyStart: number;
      readonly mainRows: number;
      readonly chromeRows: number;
      readonly chrome: readonly string[];
      readonly inputBand: { readonly lines: readonly string[] };
    }
  ): void {
    const { layout } = opts;
    const hasPanel = layout.panel !== null;

    for (let i = 0; i < opts.chromeRows; i += 1) {
      const r = opts.mainRows + i;
      const main = insetX(
        opts.chrome[i] ?? "",
        hasPanel ? layout.main.cols : opts.contentCols
      );

      screen[opts.bodyStart + r] = hasPanel
        ? paintSplitRow(
            main,
            opts.gutter,
            fitPanelCell(opts.panelSource[r] ?? "", opts.panelCols)
          )
        : main;
    }

    const inputMainCols = hasPanel ? layout.main.cols : opts.contentCols;
    const spineBase = opts.mainRows + opts.chromeRows;

    for (let i = 0; i < layout.input.rows; i += 1) {
      const mainLine = fitAnsiLine(
        opts.inputBand.lines[i] ?? "",
        inputMainCols
      );

      screen[layout.input.row + i] = hasPanel
        ? paintSplitRow(
            mainLine,
            opts.gutter,
            fitPanelCell(opts.panelSource[spineBase + i] ?? "", opts.panelCols)
          )
        : mainLine;
    }

    for (let i = 0; i < layout.footer.rows; i += 1) {
      const spineIdx = spineBase + layout.input.rows + i;

      screen[layout.footer.row + i] = hasPanel
        ? paintSplitRow(
            fitAnsiLine("", layout.main.cols),
            opts.gutter,
            fitPanelCell(opts.panelSource[spineIdx] ?? "", opts.panelCols)
          )
        : fitAnsiLine("", opts.contentCols);
    }
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
    const cursorRow = insets.originRow + layout.input.row + band.cursor.row + 1;
    const cursorCol = insets.originCol + layout.input.col + band.cursor.col + 1;

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

    // Checklist lines already carry CONSOLE hierarchy (current bright, done muted).
    // Do not blanket-dim — that erased the current-item accent.
    if (!this.focus.panelFocused) {
      return [...title, ...slice];
    }

    const body = slice.map((line, i) => {
      const abs = this.panelOffset + i;
      const plain = stripSgr(line);

      if (abs !== this.focus.selection) {
        return line;
      }

      // Current work item already leads with ▸ — recolor, don't double the gutter.
      if (plain.startsWith("▸")) {
        return paint(plain, CONSOLE.bright, true);
      }

      return paint(`▸ ${plain}`, CONSOLE.bright, true);
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

    const midRow =
      bandRows >= 3 ? 1 + cursorRow : Math.min(cursorRow, bandRows - 1);
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
 * When an overlay/menu exceeds the chrome budget, keep the first line (title)
 * and the tail (selection + footer) so the header is never scrolled away.
 */
function pinOverlayChrome(lines: readonly string[], budget: number): string[] {
  if (budget <= 0) {
    return [];
  }

  if (lines.length <= budget) {
    return [...lines];
  }

  if (budget === 1) {
    return [lines[0] ?? ""];
  }

  const head = lines[0] ?? "";
  const tail = lines.slice(lines.length - (budget - 1));

  return [head, ...tail];
}

/** One main-pane body row (+ optional panel), with scrollbar thumb overlay. */
function buildMainSplitContent(opts: {
  readonly mainText: string;
  readonly mainCols: number;
  readonly thumb: string | undefined;
  readonly gutter: string;
  readonly ruleGutter: string;
  readonly panelCell: string | null;
}): string {
  let main = insetX(opts.mainText, opts.mainCols);

  if (opts.thumb !== undefined && opts.thumb !== " ") {
    main = overlayScrollbarCol(main, opts.mainCols, opts.thumb);
  }

  if (opts.panelCell === null) {
    return main;
  }

  const splitGutter = isRailUnderRule(opts.panelCell)
    ? opts.ruleGutter
    : opts.gutter;

  return paintSplitRow(main, splitGutter, opts.panelCell);
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
