import { emitKeypressEvents } from "node:readline";
import { STYLE, paint } from "./style";
import { clampIndex } from "./command-menu";

const ESC = String.fromCharCode(27);
// Same alternate-screen approach as the `/` command palette (see command-menu.ts):
// render on the ALT buffer so frames redraw cleanly instead of fighting the status
// bar's scroll region, and exit restores the previous screen verbatim.
const ENTER_ALT = `${ESC}[?1049h${ESC}[r`;
const EXIT_ALT = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_HOME = `${ESC}[2J${ESC}[H`;

/** Most files shown at once — keeps the menu a screenful, not a 400-line dump. */
const MAX_VISIBLE = 50;

/** Basename of a workspace-relative path (the part after the last `/`). */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Lower rank = better match: basename-prefix beats path-prefix beats basename
 *  substring beats anywhere. Stable within a rank by path (see filterFiles). */
function rank(path: string, q: string): number {
  const base = baseName(path).toLowerCase();
  const full = path.toLowerCase();

  if (base.startsWith(q)) {
    return 0;
  }

  if (full.startsWith(q)) {
    return 1;
  }

  if (base.includes(q)) {
    return 2;
  }

  return 3;
}

/** Filter files by a query (the text typed after `@`), case-insensitive substring
 *  over the whole path, best matches first. Empty query ⇒ the first MAX_VISIBLE. */
export function filterFiles(files: readonly string[], query: string): string[] {
  const q = query.toLowerCase();

  if (q.length === 0) {
    return files.slice(0, MAX_VISIBLE);
  }

  return files
    .filter((f) => f.toLowerCase().includes(q))
    .sort((a, b) => {
      const byRank = rank(a, q) - rank(b, q);

      return byRank === 0 ? a.localeCompare(b) : byRank;
    })
    .slice(0, MAX_VISIBLE);
}

/** Render the file picker as a block of lines (no trailing newline). The header
 *  echoes the current `@`-query + key hints; the selected row is highlighted. */
export function renderFileMenu(
  items: readonly string[],
  selected: number,
  query: string,
  color: boolean
): string {
  const header =
    paint(`@${query}`, STYLE.brand, color) +
    paint(
      "  ↑/↓ select · type to filter · enter link · esc cancel",
      STYLE.dim,
      color
    );

  if (items.length === 0) {
    return `${header}\n  ${paint("no matching file", STYLE.dim, color)}`;
  }

  const rows = items.map((path, i) => {
    const active = i === selected;
    const gutter = active ? paint("›", STYLE.brand, color) : " ";
    const label = paint(path, active ? STYLE.brand : STYLE.bold, color);

    return `${gutter} ${label}`;
  });

  return [header, ...rows].join("\n");
}

/** True when an `@` just typed at `cursor` starts a fresh mention — i.e. the `@`
 *  is at the line start or follows whitespace. Guards against firing inside an
 *  email (`ag@host`) or a decorator typed mid-word. `cursor` is readline's index
 *  AFTER the `@` was inserted, so the `@` sits at `cursor - 1`. */
export function shouldOpenAtPicker(line: string, cursor: number): boolean {
  if (line[cursor - 1] !== "@") {
    return false;
  }

  const before = line[cursor - 2];

  return before === undefined || /\s/u.test(before);
}

/** One keypress, as decoded by readline's `emitKeypressEvents`. */
interface IKeyInfo {
  readonly name?: string;
  readonly ctrl?: boolean;
}

/**
 * The interactive `@` file picker. A direct sibling of `pickCommand` — it owns
 * `keypress` input for its lifetime (stash + detach the existing listeners so only
 * `onKey` reacts), renders a navigable file list on the alternate screen, and
 * resolves to the chosen path or null (Esc / Ctrl-C / backspace-past-empty).
 * `finish()` ALWAYS restores the saved listeners. No-ops to null off a TTY.
 *
 * Like pickCommand, stdin stays in readline's raw, flowing mode — we only swap WHO
 * listens, never toggle raw mode, so the terminal can't be left wedged.
 */
export function pickFile(
  files: readonly string[],
  color: boolean,
  out: (s: string) => void = (s) => process.stdout.write(s)
): Promise<string | null> {
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
      const items = filterFiles(files, query);

      selected = clampIndex(selected, items.length);

      out(`${CLEAR_HOME}${renderFileMenu(items, selected, query, color)}`);
    };

    const finish = (result: string | null): void => {
      stdin.removeListener("keypress", onKey);
      out(`${SHOW_CURSOR}${EXIT_ALT}`);

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

        const items = filterFiles(files, query);

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
            finish(null); // backspace past the `@` closes the picker
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
