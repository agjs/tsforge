/**
 * The geometry of the pinned bottom region, in one place. The status bar used to
 * recompute `rows - 1`, `rows - 2`, `rows - reserved - editorRows` inline at every
 * paint and resize site — and resize bugs kept landing in exactly those scattered
 * expressions (e.g. commit a255898). `computeRegions` derives every absolute row
 * once, bottom-anchored, so the bar, input row, editor block, and scroll-region
 * boundary can never drift out of agreement.
 *
 * The bottom-anchored stack, from the terminal's last row upward:
 *
 *   segRow    rows       the status segments line (always the last row)
 *   borderRow rows - 1   the dim top-border rule of the bar
 *   inputRow  rows - 2   the editable prompt (input-row mode only)
 *   editorTop ↑          top of the multi-row editor block (grows upward)
 *   regionEnd ↑          last row the scroll region may use (output scrolls above)
 */
export interface IRegionLayout {
  /** Last scrollable row; streamed output stays at or above it. */
  readonly regionEnd: number;
  /** Row of the bar's top-border rule. */
  readonly borderRow: number;
  /** Row of the bar's status segments (the bottom-most row). */
  readonly segRow: number;
  /** Row of the editable input prompt (input-row mode). */
  readonly inputRow: number;
  /** Top row of the pinned editor block (just below the scroll region). */
  readonly editorTop: number;
}

export interface IRegionInput {
  /** Total terminal rows. */
  readonly rows: number;
  /** Rows the bar reserves at the bottom: 2 bar rows, +1 for the input row.
   *  Defaults to the 2 bar rows — `borderRow`/`segRow`/`inputRow` don't depend on
   *  it, so paint sites that only need those can omit it; only `regionEnd` does. */
  readonly reserved?: number;
  /** Height of the pinned multi-row editor block above the input row (0 = none). */
  readonly editorRows?: number;
}

/**
 * Absolute 1-based rows for the pinned bottom region. Every value is clamped to
 * row ≥ 1 so a terminal shrunk below `reserved` can never emit an invalid
 * `ESC[0;1H` / negative scroll-region sequence — the same guard the call sites
 * applied by hand.
 */
export function computeRegions(input: IRegionInput): IRegionLayout {
  const { rows, reserved = 2, editorRows = 0 } = input;
  const segRow = Math.max(1, rows);
  const borderRow = Math.max(1, rows - 1);
  const inputRow = Math.max(1, rows - 2);
  const regionEnd = Math.max(1, rows - reserved - editorRows);
  const editorTop = Math.max(1, inputRow - editorRows);

  return { regionEnd, borderRow, segRow, inputRow, editorTop };
}
