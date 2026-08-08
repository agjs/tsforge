import type { IStatusInfo } from "../render.types";
import { STYLE, paint } from "../style";
import { displayWidth, sliceToWidth } from "../width";
import { stripSgr } from "./ansi-plain";

/** Prompt shown inside the input box. */
export const INPUT_PROMPT = "> ";
export const INPUT_PROMPT_COLS = 2;
/** Space between `│` and prompt (left) / trailing edge (right) — matched. */
export const INPUT_BOX_SIDE_PAD = 3;

/**
 * Columns reserved outside the draft text (borders + pads + prompt).
 * Editor wrap width = ttyCols - INPUT_EDITOR_GUTTER.
 */
export const INPUT_EDITOR_GUTTER =
  2 + INPUT_BOX_SIDE_PAD * 2 + INPUT_PROMPT_COLS; // 10

/** Draft columns available inside the box. */
export function inputContentCols(cols: number): number {
  return Math.max(1, cols - INPUT_EDITOR_GUTTER);
}

/** Absolute cursor column (0-based) for a draft caret at `draftCol`. */
export function inputCursorCol(draftCol: number): number {
  return 1 + INPUT_BOX_SIDE_PAD + INPUT_PROMPT_COLS + Math.max(0, draftCol);
}

/**
 * Input-box bottom cutout label — always empty.
 * Session chips live in the top strip only.
 */
export function formatInputStatusLabel(_info: IStatusInfo | null): string {
  return "";
}

export interface IInputBoxOpts {
  readonly cols: number;
  /** Single-line draft (used when `draftLines` is omitted). */
  readonly draft?: string;
  /** Visual draft rows — box grows with length (caller clamps). */
  readonly draftLines?: readonly string[];
  readonly placeholder?: string;
  readonly label?: string;
  readonly color?: boolean;
  readonly showPlaceholder?: boolean;
}

/**
 * Closed input box (caller insets to match the agent card width):
 *   ╭──────────────╮
 *   │ > draft…     │
 *   │   more…      │
 *   ╰──────────────╯
 */
export function formatInputBox(opts: IInputBoxOpts): {
  lines: string[];
  cursorCol: number;
} {
  const cols = Math.max(8, opts.cols);
  const color = opts.color ?? true;
  const label = opts.label ?? "";
  const rawLines =
    opts.draftLines !== undefined ? [...opts.draftLines] : [opts.draft ?? ""];
  const lines = rawLines.length > 0 ? rawLines : [""];
  const empty = lines.length === 1 && (lines[0] ?? "").length === 0;
  const showPh = opts.showPlaceholder !== false && empty;
  const placeholder = opts.placeholder ?? "describe a task, or /help";
  const midBodies = showPh
    ? [paint(placeholder, STYLE.dim, color)]
    : lines.map((line) => line);

  const mid = midBodies.map((body, i) =>
    formatInputBoxMid(cols, body, color, { showPrompt: i === 0 })
  );

  return {
    lines: [
      formatInputBoxTop(cols, color),
      ...mid,
      formatInputBoxBottom(cols, label, color),
    ],
    cursorCol: inputCursorCol(
      empty ? 0 : displayWidth(stripSgr(lines[0] ?? ""))
    ),
  };
}

/** `╭────╮` */
export function formatInputBoxTop(cols: number, color: boolean): string {
  const n = Math.max(0, cols - 2);

  return paint(`╭${"─".repeat(n)}╮`, STYLE.chrome, color);
}

export interface IInputBoxMidOpts {
  /** First draft row shows `> `; continuations indent to the same column. */
  readonly showPrompt?: boolean;
}

/** `│ > content… │` or continuation `│   content… │`. */
export function formatInputBoxMid(
  cols: number,
  body: string,
  color: boolean,
  midOpts: IInputBoxMidOpts = {}
): string {
  const showPrompt = midOpts.showPrompt !== false;
  const inner = Math.max(1, cols - 2);
  const pad = " ".repeat(INPUT_BOX_SIDE_PAD);
  const prompt = showPrompt
    ? paint(INPUT_PROMPT, STYLE.chrome, color)
    : " ".repeat(INPUT_PROMPT_COLS);
  const budget = Math.max(
    0,
    inner - INPUT_BOX_SIDE_PAD * 2 - INPUT_PROMPT_COLS
  );
  const plain = stripSgr(body);
  const fitted =
    displayWidth(plain) <= budget ? body : sliceToWidth(plain, budget).text;
  const used =
    INPUT_BOX_SIDE_PAD + INPUT_PROMPT_COLS + displayWidth(stripSgr(fitted));
  const trail = Math.max(INPUT_BOX_SIDE_PAD, inner - used);
  const left = paint("│", STYLE.chrome, color);
  const right = paint("│", STYLE.chrome, color);

  return `${left}${pad}${prompt}${fitted}${" ".repeat(trail)}${right}`;
}

/** `╰────╯` (optional right-biased label cutout when label is non-empty). */
export function formatInputBoxBottom(
  cols: number,
  label: string,
  color: boolean
): string {
  const left = "╰";
  const right = "╯";
  const inner = Math.max(0, cols - 2);

  if (label.trim().length === 0 || inner < 8) {
    return paint(`${left}${"─".repeat(inner)}${right}`, STYLE.chrome, color);
  }

  const minDash = 2;
  const maxLabel = Math.max(1, inner - minDash * 2 - 2);
  const clipped = sliceToWidth(label.trim(), maxLabel).text;
  const block = ` ${clipped} `;
  const blockW = displayWidth(block);
  const dashBudget = Math.max(0, inner - blockW);
  const rightDash = Math.max(minDash, Math.min(4, Math.floor(dashBudget / 4)));
  const leftDash = Math.max(minDash, dashBudget - rightDash);

  return (
    paint(`${left}${"─".repeat(leftDash)}`, STYLE.chrome, color) +
    paint(block, STYLE.dim, color) +
    paint(`${"─".repeat(rightDash)}${right}`, STYLE.chrome, color)
  );
}
