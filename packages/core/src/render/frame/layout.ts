import type { ILayoutRects } from "./frame.types";
import { CHROME_PAD_Y } from "./chrome";

/**
 * Minimum terminal rows before the pane TUI yields to the classic renderer.
 * Includes outer floating-window chrome (margin + border on top and bottom).
 */
export const PANE_MIN_ROWS = 16;

/** Minimum total columns to keep a side panel. */
export const PANE_SPLIT_MIN_COLS = 72;

/** Side panel width when split. */
export const PANEL_WIDTH = 28;

/**
 * Console chrome (inside the floating outer window):
 *
 *   ╭──────────────────────────────────────╮
 *   │  (air)  TSFORGE  ~/path · …          │  TOP
 *   │  ──────────────────┬──────────       │  gutter starts
 *   │  …scroll…          │ panel           │
 *   │    ╭──────────────────────────╮      │
 *   │    │ > describe a task…       │      │  INPUT = agent width
 *   │    ╰──────────────────────────╯      │
 *   ╰──────────────────────────────────────╯
 */
/** Air above the title — one row. */
export const TOP_PAD_ROWS = CHROME_PAD_Y;
export const TOP_TITLE_ROWS = 1;
/** Air between title and hairline — one row. */
export const TOP_PAD_BOTTOM_ROWS = CHROME_PAD_Y;
export const TOP_RULE_ROWS = 1;
export const TOP_STATUS_ROWS =
  TOP_PAD_ROWS + TOP_TITLE_ROWS + TOP_PAD_BOTTOM_ROWS + TOP_RULE_ROWS; // 4

/** Body headers folded into the top strip — always 0. */
export const BODY_HEADER_ROWS = 0;
/** Blank row under the top rule when the body has room. */
export const BODY_GAP_ROWS = 0;

/** Top border of the input box (`╭─╮`). */
export const INPUT_BOX_TOP_ROWS = 1;
/** Default draft / caret rows inside the box (idle / single-line). */
export const INPUT_INNER_ROWS = 1;
/**
 * Cap on draft rows as the user types / wraps. Keeps the transcript readable.
 * Enter clears the buffer → band collapses back to INPUT_INNER_ROWS.
 */
export const INPUT_INNER_ROWS_MAX = 6;
/** Bottom border (`╰─╯`). */
export const INPUT_BOX_BOTTOM_ROWS = 1;
/** Box has no air pad above (kept for older call sites). */
export const INPUT_PAD_TOP_ROWS = 0;
/** Prefer BOTTOM_PAD_ROWS below the whole input band (alias kept for call sites). */
export const INPUT_PAD_BOTTOM_ROWS = 0;

/** Total band height for a given number of draft rows (borders + mids). */
export function inputBandRows(innerRows: number): number {
  const inner = Math.max(
    INPUT_INNER_ROWS,
    Math.min(INPUT_INNER_ROWS_MAX, innerRows)
  );

  return INPUT_BOX_TOP_ROWS + inner + INPUT_BOX_BOTTOM_ROWS;
}

/** Idle / minimum closed box height. */
export const INPUT_BAND_ROWS = inputBandRows(INPUT_INNER_ROWS);

/** Clamp draft visual-line count into the growable band. */
export function clampInputInnerRows(innerRows: number): number {
  if (!Number.isFinite(innerRows)) {
    return INPUT_INNER_ROWS;
  }

  return Math.max(
    INPUT_INNER_ROWS,
    Math.min(INPUT_INNER_ROWS_MAX, Math.floor(innerRows))
  );
}

/**
 * Air below the input band. Keep at 0 so the prompt sits on the outer floor
 * (outer margin already provides edge breathing room).
 */
export const BOTTOM_PAD_ROWS = 0;

/** Alias of INPUT_BOX_TOP_ROWS (kept for older call sites). */
export const INPUT_RULE_ROWS = INPUT_BOX_TOP_ROWS;

/** Footer metrics removed — bottom pad lives in `footer`. */
export const FOOTER_RULE_ROWS = 0;
export const FOOTER_METRICS_ROWS = 0;
export const FOOTER_ROWS = BOTTOM_PAD_ROWS;
/** Idle bottom chrome (single draft row). Grows via `inputInnerRows`. */
export const BOTTOM_CHROME_ROWS = INPUT_BAND_ROWS + BOTTOM_PAD_ROWS;

/**
 * Drop the top title/rule before shrinking bottom chrome on short terminals.
 * Measured in *content* rows (inside the outer floating window). At
 * PANE_MIN_ROWS with OUTER_CHROME=2 that is 12.
 */
export const TOP_STATUS_MIN_ROWS = 12;

/** @deprecated Prefer INPUT_BAND_ROWS — kept for older call sites. */
export const INPUT_ROWS_DEFAULT = INPUT_BAND_ROWS;

export interface IComputeLayoutOpts {
  readonly rows: number;
  readonly cols: number;
  /**
   * Draft visual rows inside the input box (not including ╭/╰).
   * Defaults to 1; grows with typing up to INPUT_INNER_ROWS_MAX.
   */
  readonly inputInnerRows?: number;
  /**
   * Prefer `inputInnerRows`. When set without `inputInnerRows`,
   * treated as total band height (borders included) for older call sites.
   */
  readonly inputRows?: number;
  /**
   * When false, keep a single full-width main column.
   * Default true (empty worklist still shows the rail column when wide enough).
   */
  readonly showPanel?: boolean;
}

/** Untagged shape so legacy `inputRows` can be read without no-deprecated noise. */
interface IBandRowOpts {
  readonly inputInnerRows?: number;
  readonly inputRows?: number;
}

function resolveInputBandRows(opts: IComputeLayoutOpts): number {
  return resolveBandRowsFrom(opts);
}

function resolveBandRowsFrom(opts: IBandRowOpts): number {
  if (opts.inputInnerRows !== undefined) {
    return inputBandRows(clampInputInnerRows(opts.inputInnerRows));
  }

  if (opts.inputRows !== undefined) {
    // Legacy: callers passed total band height.
    return Math.max(
      INPUT_BAND_ROWS,
      Math.min(inputBandRows(INPUT_INNER_ROWS_MAX), Math.floor(opts.inputRows))
    );
  }

  return INPUT_BAND_ROWS;
}

/**
 * Compute top / main / panel / input / footer rectangles.
 * Status lives in the top strip; `footer` is bottom air under the input.
 */
export function computeLayout(opts: IComputeLayoutOpts): ILayoutRects {
  const topRows = opts.rows >= TOP_STATUS_MIN_ROWS ? TOP_STATUS_ROWS : 0;
  const wantedInput = resolveInputBandRows(opts);
  const bottom = Math.min(
    wantedInput + BOTTOM_PAD_ROWS,
    Math.max(1, opts.rows - topRows - 1)
  );
  const inputRows = Math.min(wantedInput, bottom);
  const footerRows = Math.min(BOTTOM_PAD_ROWS, Math.max(0, bottom - inputRows));
  const bodyRows = Math.max(1, opts.rows - topRows - inputRows - footerRows);
  const wantPanel = opts.showPanel !== false;
  const split =
    wantPanel &&
    opts.cols >= PANE_SPLIT_MIN_COLS &&
    opts.cols - PANEL_WIDTH >= 24;
  // Gutter spine runs through main + input + bottom pad.
  const spineRows = bodyRows + inputRows + footerRows;

  const top =
    topRows > 0
      ? { row: 0, col: 0, rows: topRows, cols: opts.cols }
      : { row: 0, col: 0, rows: 0, cols: opts.cols };

  const input = {
    row: topRows + bodyRows,
    col: 0,
    rows: inputRows,
    cols: opts.cols,
  };
  const footer = {
    row: topRows + bodyRows + inputRows,
    col: 0,
    rows: footerRows,
    cols: opts.cols,
  };

  if (!split) {
    return {
      top,
      main: { row: topRows, col: 0, rows: bodyRows, cols: opts.cols },
      panel: null,
      input,
      footer,
      collapsedPanel: true,
    };
  }

  const mainCols = opts.cols - PANEL_WIDTH - 1; // 1-col gutter

  return {
    top,
    main: { row: topRows, col: 0, rows: bodyRows, cols: mainCols },
    panel: {
      row: topRows,
      col: mainCols + 1,
      rows: spineRows,
      cols: PANEL_WIDTH,
    },
    input,
    footer,
    collapsedPanel: false,
  };
}

/** True when the terminal is tall enough for pane mode. */
export function canUsePaneTui(rows: number): boolean {
  return rows >= PANE_MIN_ROWS;
}
