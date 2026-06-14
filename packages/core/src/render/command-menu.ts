import { emitKeypressEvents } from "node:readline";
import { STYLE, paint } from "./style";
import { COMMANDS, type ICommandSpec } from "../cli/commands";

const ESC = String.fromCharCode(27);
// Render the palette on the terminal's ALTERNATE screen buffer: enter on open,
// clear+home before each frame, exit on close — which restores the previous screen
// (conversation + status bar) verbatim. This avoids in-place cursor math fighting
// the status bar's scroll region (which caused frames to stack instead of redraw).
const ENTER_ALT = `${ESC}[?1049h${ESC}[r`; // alt screen + reset scroll margins
const EXIT_ALT = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_HOME = `${ESC}[2J${ESC}[H`;

/** Filter commands by a query (the text typed after `/`). Leading slash and case
 *  are ignored; matches commands whose name contains the query. Empty ⇒ all. */
export function filterCommands(
  commands: readonly ICommandSpec[],
  query: string
): ICommandSpec[] {
  const q = query.replace(/^\//u, "").toLowerCase();

  if (q.length === 0) {
    return [...commands];
  }

  return commands.filter((c) => c.name.slice(1).toLowerCase().includes(q));
}

/** Keep `selected` within `[0, count)` (wraps), so ↑/↓ never points off-list. */
export function clampIndex(selected: number, count: number): number {
  if (count <= 0) {
    return 0;
  }

  return ((selected % count) + count) % count;
}

/** Render the palette as a block of lines (no trailing newline). The header echoes
 *  the current filter + key hints; the selected row is brand-highlighted. */
export function renderMenu(
  items: readonly ICommandSpec[],
  selected: number,
  query: string,
  color: boolean
): string {
  const header =
    paint(`/${query}`, STYLE.brand, color) +
    paint(
      "  ↑/↓ select · type to filter · enter run · esc cancel",
      STYLE.dim,
      color
    );

  if (items.length === 0) {
    return `${header}\n  ${paint("no matching command", STYLE.dim, color)}`;
  }

  const rows = items.map((c, i) => {
    const active = i === selected;
    const gutter = active ? paint("›", STYLE.brand, color) : " ";
    const label = c.arg === undefined ? c.name : `${c.name} ${c.arg}`;
    const name = paint(label, active ? STYLE.brand : STYLE.bold, color);

    return `${gutter} ${name}  ${paint(c.summary, STYLE.dim, color)}`;
  });

  return [header, ...rows].join("\n");
}

/** One keypress, as decoded by readline's `emitKeypressEvents`. */
interface IKeyInfo {
  readonly name?: string;
  readonly ctrl?: boolean;
}

/**
 * The interactive `/` palette. Owns `keypress` input for its lifetime — it detaches
 * the existing keypress listeners (readline's line editor + the REPL's `/` trigger)
 * so they don't also react, renders a navigable list, and resolves to the chosen
 * command or null (Esc / Ctrl-C / backspace-past-empty). `finish()` ALWAYS restores
 * the saved listeners, so input returns to normal. No-ops to null off a TTY.
 *
 * Note: stdin stays in the raw, flowing mode readline already set — we only swap
 * WHO listens, never toggle raw mode, so the terminal can't be left wedged.
 */
export function pickCommand(
  color: boolean,
  out: (s: string) => void = (s) => process.stdout.write(s)
): Promise<ICommandSpec | null> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let query = "";
    let selected = 0;

    emitKeypressEvents(stdin);

    // Take over keypress for the palette's lifetime: stash + detach the current
    // listeners (readline's editor + the REPL `/` trigger) so only `onKey` reacts;
    // restored in finish().
    const saved = stdin.rawListeners("keypress");

    stdin.removeAllListeners("keypress");

    const draw = (): void => {
      const items = filterCommands(COMMANDS, query);

      selected = clampIndex(selected, items.length);

      out(`${CLEAR_HOME}${renderMenu(items, selected, query, color)}`);
    };

    const finish = (result: ICommandSpec | null): void => {
      stdin.removeListener("keypress", onKey);
      out(`${SHOW_CURSOR}${EXIT_ALT}`); // restore the previous screen verbatim

      // Restore the listeners we detached (readline's editor + the REPL trigger),
      // forwarding through a thin wrapper so we don't fight the Function[] type.
      for (const l of saved) {
        stdin.on("keypress", (...args: unknown[]) => {
          Reflect.apply(l, stdin, args);
        });
      }

      resolve(result);
    };

    const onKey = (str: string | undefined, key: IKeyInfo): void => {
      try {
        if ((key.ctrl === true && key.name === "c") || key.name === "escape") {
          finish(null);

          return;
        }

        const items = filterCommands(COMMANDS, query);

        if (key.name === "return" || key.name === "enter") {
          finish(items[clampIndex(selected, items.length)] ?? null);
        } else if (key.name === "up") {
          selected -= 1;
          draw();
        } else if (key.name === "down") {
          selected += 1;
          draw();
        } else if (key.name === "backspace") {
          if (query.length === 0) {
            finish(null); // backspace past the slash closes the palette
          } else {
            query = query.slice(0, -1);
            selected = 0;
            draw();
          }
        } else if (key.ctrl !== true && str?.length === 1 && str >= " ") {
          query += str;
          selected = 0;
          draw();
        }
      } catch {
        finish(null); // never let a render error wedge input
      }
    };

    stdin.on("keypress", onKey);
    out(`${ENTER_ALT}${HIDE_CURSOR}`);
    draw();
  });
}
