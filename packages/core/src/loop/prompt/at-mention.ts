import { readFiles } from "../../lib/fs";
import { renderFileSection } from "./project-map";
import type { IFileView } from "../../lib/fs";

// An `@`-mention: `@` at the line start or after whitespace, then a run of
// non-space, non-`@` characters (the path). The leading boundary is captured so
// it can be preserved when the `@` is stripped. Anchoring on the boundary is what
// stops it matching inside an email (`ag@host`) or a mid-word `@`.
const AT_MENTION = /(^|\s)@([^\s@]+)/gu;

/** The unique candidate paths `@`-mentioned in a line, in first-seen order. */
export function parseAtPaths(line: string): string[] {
  const seen = new Set<string>();

  for (const m of line.matchAll(AT_MENTION)) {
    const path = m[2];

    if (path !== undefined) {
      seen.add(path);
    }
  }

  return [...seen];
}

/**
 * Resolve the `@`-mentions in a user line to file views. Each `@path` that names a
 * readable workspace file is read; the `@` is stripped from those (recognized)
 * tokens in the returned text so the model reads a clean path, while unrecognized
 * `@`-tokens (typos, decorators, non-files) are left untouched. Returns the cleaned
 * text plus the resolved views (empty when nothing matched).
 */
export async function resolveAtMentions(
  cwd: string,
  line: string
): Promise<{ text: string; views: IFileView[] }> {
  const paths = parseAtPaths(line);

  if (paths.length === 0) {
    return { text: line, views: [] };
  }

  const views = await readFiles(cwd, paths);
  const found = new Set(views.map((v) => v.path));

  const text = line.replace(AT_MENTION, (whole, pre: string, path: string) =>
    found.has(path) ? `${pre}${path}` : whole
  );

  return { text, views };
}

/**
 * Build the message actually sent for a user line: when it `@`-mentions readable
 * files, their contents (or a MAP when large — see renderFileSection) are prepended
 * so the model sees them immediately, with the `@` stripped from the inline text.
 * With no resolved mentions the line passes through unchanged.
 */
export async function composeMessage(
  cwd: string,
  line: string
): Promise<string> {
  const { text, views } = await resolveAtMentions(cwd, line);

  if (views.length === 0) {
    return text;
  }

  return `${renderFileSection(views).text}\n\n${text}`;
}
