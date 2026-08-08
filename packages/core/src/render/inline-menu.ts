import { emitKeypressEvents } from "node:readline";
import { STYLE, paint } from "./style";
import { displayWidth, sliceToWidth } from "./width";

/** Keep `selected` within `[0, count)` (wraps), so ↑/↓ never points off-list.
 *  Lives here (the menu core); `command-menu` re-exports it for its importers. */
export function clampIndex(selected: number, count: number): number {
  if (count <= 0) {
    return 0;
  }

  return ((selected % count) + count) % count;
}

/**
 * Rows shown in the popup at once — a tight dropdown above the prompt, never a
 * whole-tree dump. Matches the @file picker's MAX_VISIBLE.
 */
const MAX_VISIBLE = 8;

/** Terminal rows the status bar consumes BELOW the overlay (input row + bar
 *  border + bar + one row of margin). The overlay must fit in what remains, or
 *  the status bar's relative-redraw can't clear a region taller than the screen
 *  and the menu stacks as you scroll. */
const REGION_CHROME_ROWS = 4;

/** Non-row overlay lines: title + divider + describe + footer, plus up to two
 *  scroll indicators. Budgeted so the whole region fits the terminal height. */
const OVERLAY_OVERHEAD = 6;

const FOOTER = "↑/↓ move   enter select   esc close";

/** Clip to a display-column budget, grapheme-safe (never splits a wide cell). */
function clip(text: string, max: number): string {
  return sliceToWidth(text, max).text;
}

/** One menu row: `› label            hint`. The SELECTED row is the only styled
 *  line (cyan + bold — matches console interactive accent); every other row is
 *  plain default text so it stays fully legible. Composed as raw text and fitted
 *  to width BEFORE coloring, so clipping can never cut an ANSI escape. */
function formatRow(
  row: IMenuRowData,
  active: boolean,
  columns: number,
  color: boolean
): string {
  const avail = Math.max(0, columns - 2); // "› " / "  " gutter
  const hint = row.hint ?? "";
  let body: string;

  if (hint.length > 0) {
    const shownHint = clip(hint, Math.floor(avail / 2));
    const labelMax = Math.max(0, avail - displayWidth(shownHint) - 1);
    const shownLabel = clip(row.label, labelMax);
    const gap = Math.max(
      1,
      avail - displayWidth(shownLabel) - displayWidth(shownHint)
    );

    body = `${shownLabel}${" ".repeat(gap)}${shownHint}`;
  } else {
    body = clip(row.label, avail);
  }

  const raw = `${active ? "›" : " "} ${body}`;

  return active ? paint(raw, `${STYLE.cyan}${STYLE.bold}`, color) : raw;
}

/** Menu row data — flat list, no groups (cursor index == row index). */
export interface IMenuRowData {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly describe: string;
}

/**
 * The terminal-facing side of the inline menu, supplied by the CLI. `render` is
 * called on every change with the complete overlay block so the host can paint
 * it above the input row; `close` tears the overlay down.
 */
export interface IMenuView {
  render(lines: readonly string[]): void;
  close(): void;
}

/** One keypress, as decoded by readline's `emitKeypressEvents`. */
interface IKeyInfo {
  readonly name?: string;
  readonly ctrl?: boolean;
}

/**
 * Format the complete overlay block for an inline menu: a windowed slice of rows
 * around cursor (≤8 visible), each line with selection gutter + label + hint,
 * scroll indicators (↑/↓ N more), a divider, the selected row's full description,
 * and a footer hint. Pure/width-aware so it can be asserted without a terminal.
 * Empty list ⇒ a single "no rows" line so the dropdown never silently vanishes.
 *
 * Returns an array of formatted lines ready to paint via `statusBar.setOverlay()`.
 */
export function formatMenuRows(
  rows: readonly IMenuRowData[],
  cursor: number,
  columns: number,
  viewportRows: number,
  color: boolean,
  title: string
): string[] {
  const width = Math.max(20, columns);
  const lines: string[] = [];

  // Title: bold header at the TOP (default ink — only the selected row is cyan).
  lines.push(paint(clip(title, width), STYLE.bold, color));

  if (rows.length === 0) {
    lines.push(`  ${paint("(no items)", STYLE.dim, color)}`);
    lines.push(paint(clip(FOOTER, width), STYLE.dim, color));

    return lines;
  }

  // Cap visible rows so the WHOLE region (overlay + input + bar) fits the
  // terminal height — otherwise the status bar can't clear it and it stacks.
  const budget = viewportRows > 0 ? viewportRows : 24;
  const visible = Math.max(
    1,
    Math.min(MAX_VISIBLE, budget - REGION_CHROME_ROWS - OVERLAY_OVERHEAD)
  );

  // Scroll window: keep the cursor visible (flat list ⇒ cursor is a direct index).
  const windowTop = Math.max(0, cursor - Math.floor(visible / 2));
  const end = Math.min(rows.length, windowTop + visible);
  const start = Math.max(0, end - visible);

  if (start > 0) {
    lines.push(`  ${paint(`↑ ${start} more`, STYLE.dim, color)}`);
  }

  for (let i = start; i < end; i += 1) {
    const row = rows[i];

    if (row === undefined) {
      break;
    }

    lines.push(formatRow(row, i === cursor, width, color));
  }

  if (end < rows.length) {
    lines.push(`  ${paint(`↓ ${rows.length - end} more`, STYLE.dim, color)}`);
  }

  // Divider + the selected row's full description (default color — legible) at the
  // BOTTOM, then the footer hint.
  lines.push(paint("─".repeat(width), STYLE.dim, color));

  const selected = rows[cursor];

  if (selected !== undefined) {
    lines.push(clip(selected.describe, width));
  }

  lines.push(paint(clip(FOOTER, width), STYLE.dim, color));

  return lines;
}

/**
 * Dependencies injected by the host (cli.ts) to run the menu.
 */
export interface IInlineMenuDeps {
  /** Bold header shown at the top of the overlay (e.g. "tsforge — what can I do?"). */
  readonly title: string;
  readonly render: (lines: readonly string[]) => void;
  readonly close: () => void;
  /** Overlay width. Prefer main-pane inner cols when the pane console is live. */
  readonly columns?: number;
}

/**
 * The interactive inline menu driver. Owns `keypress` for its lifetime — stash +
 * detach the existing listeners so only `onKey` reacts. Drives the menu via deps,
 * and resolves to the chosen row index or null (Esc / Ctrl-C). Enter accepts the
 * highlighted row. `deps.close()` + listener restore ALWAYS run. No-ops if not
 * on a TTY. stdin stays in readline's raw, flowing mode — we only swap WHO
 * listens, never toggle raw mode, so the terminal can't be left wedged.
 */
export function runInlineMenu(
  rows: readonly IMenuRowData[],
  deps: IInlineMenuDeps
): Promise<number | null> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let cursor = 0;
    const columns =
      deps.columns !== undefined && deps.columns > 0
        ? deps.columns
        : process.stdout.columns > 0
          ? process.stdout.columns
          : 80;
    const color = process.stdout.isTTY;

    emitKeypressEvents(stdin);

    const saved = stdin.rawListeners("keypress");

    stdin.removeAllListeners("keypress");

    const draw = (): void => {
      cursor = clampIndex(cursor, rows.length);
      const viewportRows = process.stdout.rows > 0 ? process.stdout.rows : 24;
      const lines = formatMenuRows(
        rows,
        cursor,
        columns,
        viewportRows,
        color,
        deps.title
      );

      deps.render(lines);
    };

    const finish = (result: number | null): void => {
      stdin.removeListener("keypress", onKey);
      deps.close();

      for (const l of saved) {
        stdin.on("keypress", (...args: unknown[]) => {
          Reflect.apply(l, stdin, args);
        });
      }

      resolve(result);
    };

    const onKey = (_str: string | undefined, key: IKeyInfo): void => {
      try {
        if ((key.ctrl === true && key.name === "c") || key.name === "escape") {
          finish(null);
        } else if (key.name === "return" || key.name === "enter") {
          finish(clampIndex(cursor, rows.length));
        } else if (key.name === "up") {
          cursor -= 1;
          draw();
        } else if (key.name === "down") {
          cursor += 1;
          draw();
        }
      } catch {
        finish(null); // never let a render error wedge input
      }
    };

    stdin.on("keypress", onKey);
    draw();
  });
}
