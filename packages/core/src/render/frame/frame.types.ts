/** A single terminal cell (plain text for v1 — no per-cell SGR). */
export interface ICell {
  readonly ch: string;
}

/** One painted frame: row-major cells sized to the terminal. */
export interface IFrame {
  readonly rows: number;
  readonly cols: number;
  readonly cells: readonly (readonly ICell[])[];
}

export interface ILayoutRects {
  /** Pinned console topbar (2 rows when the terminal is tall enough). */
  readonly top: { row: number; col: number; rows: number; cols: number };
  readonly main: { row: number; col: number; rows: number; cols: number };
  readonly panel: {
    row: number;
    col: number;
    rows: number;
    cols: number;
  } | null;
  readonly input: { row: number; col: number; rows: number; cols: number };
  /** Metrics footer under the input box. */
  readonly footer: { row: number; col: number; rows: number; cols: number };
  readonly collapsedPanel: boolean;
}

export interface IPaneInput {
  readonly lines: readonly string[];
  readonly cursorRow: number;
  readonly cursorCol: number;
}
