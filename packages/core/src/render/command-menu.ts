import { emitKeypressEvents } from "node:readline";
import { COMMANDS, type ICommandSpec } from "../cli/commands";
import { clampIndex, formatMenuRows, type IMenuRowData } from "./inline-menu";

// clampIndex lives in inline-menu (the menu core); re-export it here so existing
// importers (file-menu, wizard, tests) keep working unchanged.
export { clampIndex };

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

/** A command as an inline-menu row: the name (+ arg) is the label; the summary is
 *  the description shown for the selected row. */
function commandRow(c: ICommandSpec): IMenuRowData {
  return {
    id: c.name,
    label: c.arg === undefined ? c.name : `${c.name} ${c.arg}`,
    describe: c.summary,
  };
}

/** One keypress, as decoded by readline's `emitKeypressEvents`. */
interface IKeyInfo {
  readonly name?: string;
  readonly ctrl?: boolean;
}

/**
 * The terminal-facing side of the `/` palette, supplied by the CLI. `render` gets
 * the complete overlay block (from `formatMenuRows`) plus the live query, so the
 * host can paint the dropdown above the input row and echo `/query` on the input
 * row; `close` tears it down. Mirrors the `@` file picker's IPickerView.
 */
export interface IPaletteView {
  render(lines: readonly string[]): void;
  close(): void;
  /** Overlay width. Prefer main-pane inner cols when the pane console is live. */
  readonly columns?: number;
  /** Max overlay rows. Prefer pane chrome budget when panes are live. */
  readonly viewportRows?: number;
}

/**
 * The interactive `/` command palette, rendered INLINE (no alternate screen) via
 * the shared inline-menu renderer. Owns `keypress` for its lifetime — stash +
 * detach the existing listeners so only `onKey` reacts — filters as you type, and
 * resolves to the chosen command or null (Esc / Ctrl-C / backspace-past-empty).
 * `view.close()` + listener restore ALWAYS run. No-ops to null off a TTY. stdin
 * stays in readline's raw, flowing mode — we only swap WHO listens, never toggle
 * raw mode, so the terminal can't be left wedged.
 */
export function pickCommand(view: IPaletteView): Promise<ICommandSpec | null> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let query = "";
    let selected = 0;

    emitKeypressEvents(stdin);

    const saved = stdin.rawListeners("keypress");

    stdin.removeAllListeners("keypress");

    const draw = (): void => {
      const items = filterCommands(COMMANDS, query);

      selected = clampIndex(selected, items.length);

      const columns =
        view.columns !== undefined && view.columns > 0
          ? view.columns
          : process.stdout.columns > 0
            ? process.stdout.columns
            : 80;
      const viewportRows =
        view.viewportRows !== undefined && view.viewportRows > 0
          ? view.viewportRows
          : process.stdout.rows > 0
            ? process.stdout.rows
            : 24;
      // The live query IS the title (e.g. "/co"), so it shows via the overlay even
      // while the editor is suspended (setInput wouldn't repaint in editor mode).
      const title = query.length > 0 ? `/${query}` : "commands";
      const lines = formatMenuRows(
        items.map(commandRow),
        selected,
        columns,
        viewportRows,
        process.stdout.isTTY,
        title
      );

      view.render(lines);
    };

    const finish = (result: ICommandSpec | null): void => {
      stdin.removeListener("keypress", onKey);
      view.close();

      for (const l of saved) {
        stdin.on("keypress", (...args: unknown[]) => {
          Reflect.apply(l, stdin, args);
        });
      }

      resolve(result);
    };

    const accept = (): void => {
      const items = filterCommands(COMMANDS, query);

      finish(items[clampIndex(selected, items.length)] ?? null);
    };

    const onKey = (str: string | undefined, key: IKeyInfo): void => {
      try {
        if ((key.ctrl === true && key.name === "c") || key.name === "escape") {
          finish(null);
        } else if (key.name === "return" || key.name === "enter") {
          accept();
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
    draw();
  });
}
