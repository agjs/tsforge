import { emitKeypressEvents } from "node:readline";
import type { ITsSymbol } from "../lsp/lsp.types";
import { STYLE, paint } from "./style";
import { clampIndex } from "./command-menu";
import { formatMenuRow } from "./menu-chrome";
import { CONSOLE } from "./frame/chrome";
import { displayWidth, graphemes } from "./width";

/** Rows shown in the popup at once — a tight dropdown above the prompt, never a
 *  whole-tree dump. On an empty query these are the most-recently-modified files. */
const MAX_VISIBLE = 8;

/** A candidate row in the `@` mention picker — a workspace file or an LSP symbol. */
export type IMentionItem =
  | { kind: "file"; path: string }
  | {
      kind: "symbol";
      name: string;
      symbolKind: string;
      file: string;
      line: number;
    };

/** True when `query` looks like the start of a TypeScript identifier — the gate
 *  for mixing workspace symbols into the `@` picker (paths like `src/` stay
 *  file-only). */
function looksLikeIdentifier(query: string): boolean {
  return query.length >= 1 && /^[A-Za-z_$]\w*$/u.test(query);
}

/** Rank for merged file/symbol rows — lower is better. Symbol prefix beats file
 *  basename prefix beats symbol substring beats file path/substring matches. */
function mentionRank(item: IMentionItem, q: string): number {
  const ql = q.toLowerCase();

  if (item.kind === "symbol") {
    const nl = item.name.toLowerCase();

    return nl.startsWith(ql) ? 0 : 2;
  }

  const base = baseName(item.path).toLowerCase();
  const full = item.path.toLowerCase();

  if (base.startsWith(ql)) {
    return 1;
  }

  if (full.startsWith(ql)) {
    return 3;
  }

  if (base.includes(ql)) {
    return 4;
  }

  return 5;
}

/** Text inserted after `@` when a mention row is accepted. */
export function mentionInsertText(item: IMentionItem): string {
  return item.kind === "file" ? item.path : `${item.file}:${item.line}`;
}

/** Basename of a workspace-relative path (the part after the last `/`). */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Lowercased path/basename per file list — computed once per list identity,
 *  not per @-picker keystroke (lowercasing up to 10k paths per keypress). */
const lowerIndexCache = new WeakMap<
  readonly string[],
  { full: string[]; base: string[] }
>();

function lowerIndex(files: readonly string[]): {
  full: string[];
  base: string[];
} {
  const hit = lowerIndexCache.get(files);

  if (hit !== undefined) {
    return hit;
  }

  const built = {
    full: files.map((f) => f.toLowerCase()),
    base: files.map((f) => baseName(f).toLowerCase()),
  };

  lowerIndexCache.set(files, built);

  return built;
}

/** Lower rank = better match: basename-prefix beats path-prefix beats basename
 *  substring beats anywhere. Ties keep the caller's order (recency) — sort is
 *  stable — so the most-recently-touched match within a rank surfaces first. */
function rankLowered(base: string, full: string, q: string): number {
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
 *  over the whole path, best matches first (ties keep caller/recency order — sort
 *  is stable). Empty query ⇒ the first MAX_VISIBLE of the caller's order. */
export function filterFiles(files: readonly string[], query: string): string[] {
  const q = query.toLowerCase();

  if (q.length === 0) {
    return files.slice(0, MAX_VISIBLE);
  }

  const { full, base } = lowerIndex(files);
  const matched: { path: string; rank: number }[] = [];

  for (let i = 0; i < files.length; i += 1) {
    const f = full[i] ?? "";

    if (f.includes(q)) {
      matched.push({
        path: files[i] ?? "",
        rank: rankLowered(base[i] ?? "", f, q),
      });
    }
  }

  return matched
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_VISIBLE)
    .map((m) => m.path);
}

/** Filter workspace files and (optionally) LSP symbols for the `@` picker.
 *  Symbol hits are included only when `query` looks like an identifier and
 *  `symbols` is supplied — otherwise this is file-only (same cap/ranking feel
 *  as `filterFiles`). Pass `rel` to show symbol paths workspace-relative. */
export function filterMentionItems(
  files: readonly string[],
  query: string,
  symbols?: readonly ITsSymbol[],
  rel?: (abs: string) => string
): IMentionItem[] {
  if (
    query.length === 0 ||
    !looksLikeIdentifier(query) ||
    symbols === undefined
  ) {
    return filterFiles(files, query).map((path) => ({
      kind: "file" as const,
      path,
    }));
  }

  const q = query.toLowerCase();
  const { full } = lowerIndex(files);
  const fileMatched: { item: IMentionItem; rank: number }[] = [];

  for (let i = 0; i < files.length; i += 1) {
    const lowered = full[i] ?? "";

    if (lowered.includes(q)) {
      const item: IMentionItem = { kind: "file", path: files[i] ?? "" };

      fileMatched.push({ item, rank: mentionRank(item, q) });
    }
  }

  const symbolMatched = symbols
    .filter((s) => s.name.toLowerCase().includes(q))
    .map((s) => {
      const item: IMentionItem = {
        kind: "symbol",
        name: s.name,
        symbolKind: s.kind,
        file: rel !== undefined ? rel(s.file) : s.file,
        line: s.line,
      };

      return { item, rank: mentionRank(item, q) };
    });

  return [...symbolMatched, ...fileMatched]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_VISIBLE)
    .map((m) => m.item);
}

/** Truncate a path to `max` columns keeping its TAIL (the filename matters most),
 *  prefixing `…` when clipped. `max <= 0` ⇒ empty. */
export function truncatePath(path: string, max: number): string {
  if (max <= 0) {
    return "";
  }

  if (displayWidth(path) <= max) {
    return path;
  }

  // Keep the grapheme-aligned tail that fits in `max - 1` columns (the `…` takes
  // one), so a wide cell at the clip boundary is never split.
  const gs = graphemes(path);
  let cols = 0;
  let startG = gs.length;

  for (let i = gs.length - 1; i >= 0; i -= 1) {
    const w = displayWidth(gs[i] ?? "");

    if (cols + w > max - 1) {
      break;
    }

    cols += w;
    startG = i;
  }

  return `…${gs.slice(startG).join("")}`;
}

/**
 * The popup rows for the inline `@` dropdown — one painted line per visible item,
 * each truncated to `columns` (no wrapping), the selected row gutter-highlighted
 * with the shared menu dialect (`▸` + CONSOLE.bright). Pure/width-aware so it can
 * be asserted without a terminal. Empty list ⇒ a single "no matching file" row so
 * the dropdown never silently vanishes mid-type.
 */
export function formatCompletionRows(
  items: readonly IMentionItem[],
  selected: number,
  columns: number,
  color: boolean
): string[] {
  if (items.length === 0) {
    return [`  ${paint("no matching file", STYLE.dim, color)}`];
  }

  return items.map((item, i) => {
    const active = i === selected;
    const text =
      item.kind === "file"
        ? truncatePath(item.path, Math.max(0, columns - 2))
        : formatSymbolRow(item, columns - 2);

    if (active) {
      return formatMenuRow({
        label: text,
        active: true,
        columns,
        color,
      });
    }

    if (item.kind === "symbol") {
      const loc = `${item.file}:${item.line}`;
      const locBudget = Math.max(
        8,
        columns - 2 - displayWidth(`${item.symbolKind} ${item.name} — `)
      );
      const locText = truncatePath(loc, locBudget);
      const body = `${paint(item.symbolKind, STYLE.dim, color)} ${paint(item.name, CONSOLE.bright, color)} ${paint(`— ${locText}`, STYLE.dim, color)}`;

      return `  ${body}`;
    }

    // Inactive file: shared gutter width, dim path (quiet under the input).
    return `  ${paint(text, STYLE.dim, color)}`;
  });
}

function formatSymbolRow(
  item: Extract<IMentionItem, { kind: "symbol" }>,
  max: number
): string {
  const loc = truncatePath(
    `${item.file}:${item.line}`,
    Math.max(8, max - displayWidth(`${item.symbolKind} ${item.name} — `))
  );

  return `${item.symbolKind} ${item.name} — ${loc}`;
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
 * The terminal-facing side of the inline picker, supplied by the CLI. `render` is
 * called on every change with the current query + filtered items so the host can
 * paint the dropdown above the input row and echo the live `@query`; `close` tears
 * the dropdown down. Keeping these as callbacks lets pickFileInline own only the
 * keypress state machine, with no knowledge of the status bar.
 */
export interface IPickerView {
  render(query: string, items: readonly IMentionItem[], selected: number): void;
  close(): void;
}

/**
 * The interactive `@` file picker, rendered INLINE (no alternate screen): it owns
 * `keypress` for its lifetime — stash + detach the existing listeners so only
 * `onKey` reacts — drives a tight dropdown via `view`, and resolves to the chosen
 * path or null (Esc / Ctrl-C / backspace-past-empty). Enter or Tab accept the
 * highlighted row. `view.close()` + listener restore ALWAYS run. No-ops to null
 * off a TTY. stdin stays in readline's raw, flowing mode — we only swap WHO
 * listens, never toggle raw mode, so the terminal can't be left wedged.
 */
export function pickFileInline(
  files: readonly string[],
  view: IPickerView
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
      const items = filterFiles(files, query).map((path) => ({
        kind: "file" as const,
        path,
      }));

      selected = clampIndex(selected, items.length);
      view.render(query, items, selected);
    };

    const finish = (result: string | null): void => {
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
      const items = filterFiles(files, query).map((path) => ({
        kind: "file" as const,
        path,
      }));
      const picked = items[clampIndex(selected, items.length)];

      finish(picked === undefined ? null : mentionInsertText(picked));
    };

    const onKey = (str: string | undefined, key: IKeyInfo): void => {
      try {
        if ((key.ctrl === true && key.name === "c") || key.name === "escape") {
          finish(null);
        } else if (key.name === "return" || key.name === "enter") {
          accept();
        } else if (key.name === "tab") {
          accept();
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
    draw();
  });
}
