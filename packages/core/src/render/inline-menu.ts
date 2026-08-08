import { emitKeypressEvents } from "node:readline";
import { STYLE, paint } from "./style";
import {
  MENU_FOOTER_NAV,
  formatMenuRow,
  formatOverlayShell,
  menuBodyBudget,
  menuScrollCue,
  menuWindow,
} from "./menu-chrome";

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
 * Returns lines ready for {@link PaneScreen.setOverlay}.
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

  if (rows.length === 0) {
    return formatOverlayShell({
      title,
      bodyLines: [`  ${paint("(no items)", STYLE.dim, color)}`],
      footer: MENU_FOOTER_NAV,
      columns: width,
      color,
    });
  }

  const bodyCap = Math.min(
    MAX_VISIBLE,
    menuBodyBudget(viewportRows, { hasDescribe: true })
  );
  const { start, end } = menuWindow(rows.length, cursor, bodyCap);
  const bodyLines: string[] = [];

  if (start > 0) {
    bodyLines.push(menuScrollCue("up", start, color));
  }

  for (let i = start; i < end; i += 1) {
    const row = rows[i];

    if (row === undefined) {
      break;
    }

    bodyLines.push(
      formatMenuRow({
        label: row.label,
        hint: row.hint,
        active: i === cursor,
        columns: width,
        color,
      })
    );
  }

  if (end < rows.length) {
    bodyLines.push(menuScrollCue("down", rows.length - end, color));
  }

  const selected = rows[cursor];

  return formatOverlayShell({
    title,
    bodyLines,
    describe: selected?.describe ?? "",
    footer: MENU_FOOTER_NAV,
    columns: width,
    color,
  });
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
  /**
   * Max overlay rows (pane chrome budget). Prefer
   * {@link PaneScreen.overlayBudgetRows} when panes are live.
   */
  readonly viewportRows?: number;
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
      const viewportRows =
        deps.viewportRows !== undefined && deps.viewportRows > 0
          ? deps.viewportRows
          : process.stdout.rows > 0
            ? process.stdout.rows
            : 24;
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
