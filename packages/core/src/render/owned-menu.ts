import { emitKeypressEvents } from "node:readline";
import { STYLE, paint } from "./style";
import { clampIndex } from "./command-menu";

/**
 * Generic owned-stdin menu driver: groups of rows with descriptions,
 * arrow navigation, Enter to select, Esc to exit. Owns the alt-screen,
 * keypress events, and the suspend/resume handshake with the editor.
 * Used by both /config and /help capability browser.
 */

export interface IMenuRow {
  readonly group: string;
  readonly label: string;
  readonly describe: string;
  readonly value?: string;
}

export interface IOwnedMenuSelectControl {
  /** Temporarily pause the input loop (used when onSelect needs to handle its own input). */
  readonly pause: () => void;
  /** Resume the input loop after pause. */
  readonly resume: () => void;
  /** Signal that the menu should exit after the current onSelect completes. */
  readonly close: () => void;
}

export interface IOwnedMenuDeps {
  readonly color: boolean;
  /** e.g. "tsforge config" or "tsforge — what can I do?" */
  readonly title: string;
  /** e.g. "Settings · change anything here" */
  readonly subtitle: string;
  /** e.g. "↑/↓ move   enter change   esc done" */
  readonly footer: string;
  /** Detach the REPL editor around this session. */
  readonly suspend: () => void;
  /** Re-attach the REPL editor after this session. */
  readonly resume: () => void;
  /** Rows to display (re-read after each activation for live values). */
  readonly rows: () => readonly IMenuRow[];
  /** Fired when user presses Enter on row at index. */
  readonly onSelect: (
    index: number,
    control: IOwnedMenuSelectControl
  ) => void | Promise<void>;
  /** Optional: draw an explainer or handle sub-view yourself. */
  readonly onExit?: () => void;
}

interface IMenuState {
  cursor: number;
}

interface IKeyInfo {
  readonly name?: string;
  readonly ctrl?: boolean;
}

// ── constants ────────────────────────────────────────────────────────────────

const ESC = String.fromCharCode(27);
const ENTER_ALT = `${ESC}[?1049h${ESC}[r`;
const EXIT_ALT = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_HOME = `${ESC}[2J${ESC}[H`;
const RULE = "─".repeat(52);

// ── rendering (pure) ─────────────────────────────────────────────────────────

/**
 * Render the menu screen from rows, cursor, and styling.
 * Groups are inferred from row.group; each row shows its description
 * on a dim line below it.
 */
export function renderMenu(
  rows: readonly IMenuRow[],
  cursor: number,
  color: boolean
): string {
  const lines: string[] = [];
  let group = "";

  rows.forEach((row, i) => {
    if (row.group !== group) {
      group = row.group;
      lines.push("", paint(group, STYLE.bold, color));
    }

    const active = i === cursor;
    const gutter = active ? paint("›", STYLE.brand, color) : " ";
    const label = paint(row.label, active ? STYLE.brand : STYLE.bold, color);
    const value = paint(row.value ?? "", STYLE.brandLight, color);

    // Every row carries its own one-line description directly beneath it.
    lines.push(`${gutter} ${label}  ${paint("·", STYLE.dim, color)} ${value}`);
    lines.push(`    ${paint(row.describe, STYLE.dim, color)}`);
  });

  return [
    paint(rows.length === 0 ? "" : "", STYLE.brand, color), // placeholder for title override
    ...lines,
    "",
    paint(rows.length === 0 ? "" : "", STYLE.dim, color), // placeholder for footer override
  ]
    .join("\n")
    .replace(/^\n/, "")
    .replace(/\n\n$/, "");
}

/**
 * Render the menu screen with a custom title, subtitle, and footer.
 */
function renderMenuWithHeaders(
  rows: readonly IMenuRow[],
  cursor: number,
  title: string,
  subtitle: string,
  footer: string,
  color: boolean
): string {
  const lines: string[] = [];
  let group = "";

  rows.forEach((row, i) => {
    if (row.group !== group) {
      group = row.group;
      lines.push("", paint(row.group, STYLE.bold, color));
    }

    const active = i === cursor;
    const gutter = active ? paint("›", STYLE.brand, color) : " ";
    const label = paint(row.label, active ? STYLE.brand : STYLE.bold, color);
    const value = paint(row.value ?? "", STYLE.brandLight, color);

    lines.push(`${gutter} ${label}  ${paint("·", STYLE.dim, color)} ${value}`);
    lines.push(`    ${paint(row.describe, STYLE.dim, color)}`);
  });

  return [
    paint(title, STYLE.brand, color),
    subtitle,
    RULE,
    ...lines,
    "",
    paint(footer, STYLE.dim, color),
  ].join("\n");
}

// ── the driver ───────────────────────────────────────────────────────────────

/**
 * Run a menu loop: display rows, navigate with arrow keys, select with Enter,
 * exit with Esc. Owns stdin for its lifetime. The editor is suspended/resumed
 * via `deps.suspend()` and `deps.resume()`.
 *
 * Rows are fetched dynamically (via `deps.rows()`) so live values reflect after
 * selections. When user presses Enter, `deps.onSelect(index)` is called; the
 * menu redraws after the Promise resolves.
 */
export function runOwnedMenu(deps: IOwnedMenuDeps): Promise<void> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const state: IMenuState = { cursor: 0 };

    deps.suspend();
    emitKeypressEvents(stdin);

    const saved = stdin.rawListeners("keypress");

    stdin.removeAllListeners("keypress");

    const out = (s: string): void => {
      process.stdout.write(s);
    };

    const draw = (): void => {
      const rows = deps.rows();

      out(
        `${CLEAR_HOME}${renderMenuWithHeaders(
          rows,
          state.cursor,
          deps.title,
          deps.subtitle,
          deps.footer,
          deps.color
        )}`
      );
    };

    const finish = (): void => {
      stdin.removeListener("keypress", onKey);

      try {
        out(`${SHOW_CURSOR}${EXIT_ALT}`);
      } catch {
        // stream closed — cleanup below still runs
      }

      for (const l of saved) {
        stdin.on("keypress", (...args: unknown[]) => {
          Reflect.apply(l, stdin, args);
        });
      }

      deps.resume();
      deps.onExit?.();
      resolve();
    };

    const selectRow = (): void => {
      const rows = deps.rows();

      if (state.cursor >= rows.length) {
        return;
      }

      let shouldClose = false;

      const control: IOwnedMenuSelectControl = {
        pause: () => {
          stdin.removeListener("keypress", onKey);
        },
        resume: () => {
          stdin.on("keypress", onKey);
        },
        close: () => {
          shouldClose = true;
        },
      };

      // Call onSelect and redraw after the Promise resolves, unless close() was called.
      void Promise.resolve(deps.onSelect(state.cursor, control))
        .then(() => {
          if (shouldClose) {
            finish();
          } else {
            draw();
          }
        })
        .catch(() => {
          if (shouldClose) {
            finish();
          } else {
            draw();
          }
        });
    };

    const onKey = (_str: string | undefined, key: IKeyInfo): void => {
      try {
        if ((key.ctrl === true && key.name === "c") || key.name === "escape") {
          finish();

          return;
        }

        const rows = deps.rows();

        if (key.name === "up") {
          state.cursor = clampIndex(state.cursor - 1, rows.length);
          draw();
        } else if (key.name === "down") {
          state.cursor = clampIndex(state.cursor + 1, rows.length);
          draw();
        } else if (key.name === "return") {
          selectRow();
        }
      } catch {
        finish();
      }
    };

    stdin.on("keypress", onKey);
    out(`${ENTER_ALT}${HIDE_CURSOR}`);
    draw();
  });
}
