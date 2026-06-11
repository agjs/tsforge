import { highlight } from "cli-highlight";
import { STYLE, paint } from "./style";
import { table } from "./box";

/**
 * Markdown → terminal formatting, shared by the settled-message renderer
 * (ansi.ts) and the live streaming renderer (stream-markdown.ts) so a streamed
 * answer and a re-rendered one look identical.
 */

/**
 * Render an assistant message: fenced ```code``` blocks syntax-highlighted, and
 * GitHub-flavored markdown TABLES drawn as real box tables (the model answers with
 * `| a | b |` tables constantly — raw they're unreadable pipe soup). Other prose
 * passes through.
 */
export function renderMarkdown(text: string, color: boolean): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      const fence = /^```([\w-]*)\n?([\s\S]*?)\n?```$/.exec(part);

      if (fence === null) {
        return formatTables(part, color);
      }

      const lang =
        fence[1] !== undefined && fence[1].length > 0 ? fence[1] : "typescript";

      return highlightCode(fence[2] ?? "", lang, color);
    })
    .join("");
}

/** A markdown table separator row, e.g. `|----|:--:|---|`. */
function isTableSeparator(line: string | undefined): boolean {
  return (
    line !== undefined &&
    line.includes("|") &&
    line.includes("-") &&
    /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line)
  );
}

/** Split a `| a | b |` row into trimmed cells (tolerates missing edge pipes). */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Replace each GFM table block in `text` with a box-drawn table; leave the rest. */
export function formatTables(text: string, color: boolean): string {
  const lines = text.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; ) {
    const header = lines[i];

    if (
      header !== undefined &&
      header.includes("|") &&
      isTableSeparator(lines[i + 1])
    ) {
      const rows: string[][] = [tableCells(header)];
      let j = i + 2;

      while (j < lines.length && (lines[j]?.includes("|") ?? false)) {
        rows.push(tableCells(lines[j] ?? ""));
        j += 1;
      }

      out.push(table(rows, color));
      i = j;
    } else {
      out.push(header ?? "");
      i += 1;
    }
  }

  return out.join("\n");
}

export function highlightCode(
  code: string,
  lang: string,
  color: boolean
): string {
  if (!color) {
    return code;
  }

  try {
    return highlight(code, { language: lang, ignoreIllegals: true });
  } catch {
    return code;
  }
}

/** Cheap inline styling for one streamed prose line — `#` headings and
 *  `**bold**` brighten, `code` spans go cyan. No-op without color. */
export function styleInline(line: string, color: boolean): string {
  if (!color) {
    return line;
  }

  const heading = /^#{1,6}\s+(.*)$/.exec(line);

  if (heading !== null) {
    return paint(heading[1] ?? "", STYLE.bold, color);
  }

  return line
    .replace(/\*\*([^*]+)\*\*/g, (_m: string, t: string) =>
      paint(t, STYLE.bold, color)
    )
    .replace(/`([^`]+)`/g, (_m: string, t: string) =>
      paint(t, STYLE.cyan, color)
    );
}
