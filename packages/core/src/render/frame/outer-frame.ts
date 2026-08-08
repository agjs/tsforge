import { STYLE, paint } from "../style";
import { stripSgr } from "./ansi-plain";
import { fitAnsiLine } from "./fit-line";

/** Blank cells between the terminal edge and the outer box. */
export const OUTER_MARGIN = 1;
/** Thickness of the floating-window border (one cell). */
export const OUTER_BORDER = 1;
/** Margin + border on each side. */
export const OUTER_CHROME = OUTER_MARGIN + OUTER_BORDER;

export interface IOuterInsets {
  /** 0-based row of the first content cell (inside the border). */
  readonly originRow: number;
  /** 0-based col of the first content cell. */
  readonly originCol: number;
  readonly contentRows: number;
  readonly contentCols: number;
}

/** Content rect inside the floating window for a terminal of `rows`×`cols`. */
export function outerInsets(rows: number, cols: number): IOuterInsets {
  const originRow = OUTER_CHROME;
  const originCol = OUTER_CHROME;
  const contentRows = Math.max(1, rows - 2 * OUTER_CHROME);
  const contentCols = Math.max(8, cols - 2 * OUTER_CHROME);

  return { originRow, originCol, contentRows, contentCols };
}

export interface IOuterFrameOpts {
  readonly color?: boolean;
  /**
   * 0-based content column of the panel gutter. When set, the bottom edge
   * uses `┴` so the vertical spine closes into the outer frame.
   */
  readonly splitCol?: number;
}

/**
 * Wrap content lines (exactly `contentRows` × `contentCols`) in margin +
 * chrome border so the result is `termRows` × `termCols`.
 */
export function wrapOuterFrame(
  content: readonly string[],
  termRows: number,
  termCols: number,
  opts: boolean | IOuterFrameOpts = true
): string[] {
  const options = typeof opts === "boolean" ? { color: opts } : opts;
  const color = options.color !== false;
  const { originRow, contentCols } = outerInsets(termRows, termCols);
  const screen: string[] = [];
  const blank = fitAnsiLine("", termCols);
  const top = frameHorizEdge("╭", "╮", contentCols, termCols, color);
  const bottom = frameHorizEdge("╰", "╯", contentCols, termCols, color, {
    splitCol: options.splitCol,
    junction: "┴",
  });

  for (let r = 0; r < termRows; r += 1) {
    if (r < OUTER_MARGIN || r >= termRows - OUTER_MARGIN) {
      screen.push(blank);
      continue;
    }

    if (r === OUTER_MARGIN) {
      screen.push(top);
      continue;
    }

    if (r === termRows - OUTER_MARGIN - 1) {
      screen.push(bottom);
      continue;
    }

    screen.push(
      frameContentRow(content[r - originRow] ?? "", termCols, {
        color,
        splitCol: options.splitCol,
      })
    );
  }

  return screen;
}

/**
 * True when `contentLine` is a full-bleed horizontal rule (─ / ┬ / ┴ / ┼).
 * Those rows need `├`/`┤` side glyphs so the rule joins the outer rails —
 * bare `│────│` reads as a floating segment in the terminal font.
 */
export function isFullBleedRule(contentLine: string): boolean {
  const plain = stripSgr(contentLine);

  if (plain.length === 0) {
    return false;
  }

  return /^[─┬┴┼]+$/u.test(plain);
}

/**
 * Panel-only under-rule: gutter at `splitCol` is `├`/`│`/`┼` and the panel
 * cells are all `─`. Needs a right `┤` so the rule does not float.
 */
export function isPanelRuleRow(
  contentLine: string,
  splitCol: number | undefined
): boolean {
  if (splitCol === undefined || splitCol < 0) {
    return false;
  }

  const plain = stripSgr(contentLine);

  if (splitCol >= plain.length) {
    return false;
  }

  const gutter = plain[splitCol];

  if (gutter !== "├" && gutter !== "│" && gutter !== "┼") {
    return false;
  }

  const panel = plain.slice(splitCol + 1);

  return panel.length > 0 && /^─+$/u.test(panel);
}

export interface IFrameContentRowOpts {
  readonly color?: boolean;
  /** 0-based content column of the panel gutter (for panel-only rules). */
  readonly splitCol?: number;
}

/** Stamp one content row into a full-width framed terminal line. */
export function frameContentRow(
  contentLine: string,
  termCols: number,
  colorOrOpts: boolean | IFrameContentRowOpts = true
): string {
  const opts =
    typeof colorOrOpts === "boolean" ? { color: colorOrOpts } : colorOrOpts;
  const color = opts.color !== false;
  const { originCol, contentCols } = outerInsets(OUTER_CHROME * 2 + 1, termCols);
  const full = isFullBleedRule(contentLine);
  const panelRule = !full && isPanelRuleRow(contentLine, opts.splitCol);
  const left = paint(full ? "├" : "│", STYLE.chrome, color);
  const right = paint(full || panelRule ? "┤" : "│", STYLE.chrome, color);
  const inner = fitAnsiLine(contentLine, contentCols);
  const row =
    " ".repeat(originCol - OUTER_BORDER) +
    left +
    inner +
    right +
    " ".repeat(Math.max(0, termCols - originCol - contentCols - OUTER_BORDER));

  return fitAnsiLine(row, termCols);
}

function frameHorizEdge(
  left: string,
  right: string,
  contentCols: number,
  termCols: number,
  color: boolean,
  junction?: { splitCol?: number; junction?: string }
): string {
  const splitCol = junction?.splitCol;
  const glyph = junction?.junction ?? "┴";
  let mid: string;

  if (
    splitCol !== undefined &&
    splitCol >= 0 &&
    splitCol < contentCols &&
    contentCols > 0
  ) {
    mid =
      "─".repeat(splitCol) +
      glyph +
      "─".repeat(Math.max(0, contentCols - splitCol - 1));
  } else {
    mid = "─".repeat(Math.max(0, contentCols));
  }

  const bar = paint(`${left}${mid}${right}`, STYLE.chrome, color);

  return fitAnsiLine(`${" ".repeat(OUTER_MARGIN)}${bar}`, termCols);
}
