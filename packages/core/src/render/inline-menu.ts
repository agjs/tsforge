import { emitKeypressEvents } from "node:readline";
import { STYLE, paint } from "./style";
import { clampIndex } from "./command-menu";
import { displayWidth, padToWidth } from "./width";

/**
 * Rows shown in the popup at once — a tight dropdown above the prompt, never a
 * whole-tree dump. Matches the @file picker's MAX_VISIBLE.
 */
const MAX_VISIBLE = 8;

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
  color: boolean
): string[] {
  if (rows.length === 0) {
    return [`  ${paint("(no items)", STYLE.dim, color)}`];
  }

  const lines: string[] = [];
  const safeColumns = Math.max(20, columns);

  // ── scroll window: keep cursor visible, show ≤MAX_VISIBLE rows at once ───

  const start = Math.max(0, cursor - Math.floor(MAX_VISIBLE / 2));
  const end = Math.min(rows.length, start + MAX_VISIBLE);
  const actualStart = Math.max(0, end - MAX_VISIBLE);

  // Prepend "↑ N more" if rows exist above the window.
  if (actualStart > 0) {
    lines.push(`  ${paint(`↑ ${actualStart} more`, STYLE.dim, color)}`);
  }

  // Render the windowed slice.
  for (let i = actualStart; i < end; i += 1) {
    const row = rows[i];

    if (row === undefined) {
      break;
    }

    const active = i === cursor;
    const gutter = active ? paint("›", STYLE.brand, color) : " ";
    const label = paint(row.label, active ? STYLE.brand : STYLE.bold, color);

    // Hint (optional) shown right-aligned with spacing — use available space
    // after label to fit the hint, or skip if too tight.
    let hint = "";

    if (row.hint !== undefined && row.hint.length > 0) {
      const hintDim = paint(row.hint, STYLE.dim, color);
      const labelWidth = displayWidth(row.label);
      const hintWidth = displayWidth(row.hint);
      const gutterAndSpace = 2; // "› "

      // If there's room (gutter + space + label + spacing + hint <= columns),
      // right-align the hint with at least 3 spaces of padding.
      const availableForHint = safeColumns - gutterAndSpace - labelWidth - 3;

      if (availableForHint >= hintWidth) {
        const padding = safeColumns - gutterAndSpace - labelWidth - hintWidth;

        hint = `${" ".repeat(Math.max(1, padding))}${hintDim}`;
      }
    }

    const line = `${gutter} ${label}${hint}`;

    // Truncate to columns, respecting wide characters (no wrapping).
    lines.push(padToWidth(line.slice(0, safeColumns), safeColumns));
  }

  // Append "↓ N more" if rows exist below the window.
  if (end < rows.length) {
    lines.push(`  ${paint(`↓ ${rows.length - end} more`, STYLE.dim, color)}`);
  }

  // ── divider, description, footer ────────────────────────────────────────

  const selectedRow = rows[cursor];

  lines.push("─".repeat(safeColumns));

  if (selectedRow !== undefined) {
    lines.push(selectedRow.describe);
  }

  lines.push(paint("↑/↓ move   enter select   esc close", STYLE.dim, color));

  return lines;
}

/**
 * Dependencies injected by the host (cli.ts) to run the menu.
 */
export interface IInlineMenuDeps {
  readonly render: (lines: readonly string[]) => void;
  readonly close: () => void;
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
    const columns = process.stdout.columns > 0 ? process.stdout.columns : 80;
    const color = process.stdout.isTTY;

    emitKeypressEvents(stdin);

    const saved = stdin.rawListeners("keypress");

    stdin.removeAllListeners("keypress");

    const draw = (): void => {
      cursor = clampIndex(cursor, rows.length);
      const lines = formatMenuRows(rows, cursor, columns, color);

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
