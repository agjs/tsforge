import { join } from "node:path";
import { EDIT_FAIL_REASON } from "./files.constants";
import type {
  IEdit,
  EditResult,
  IReplacement,
  EditsResult,
} from "./files.types";

/**
 * Apply a str_replace edit. The match must be **exact and unique** — 0 matches
 * is `not-found`, >1 is `ambiguous` (the model must add surrounding context).
 * Uniqueness is what makes blind edits safe for a strong, full-file-context model.
 */
export async function applyEdit(cwd: string, edit: IEdit): Promise<EditResult> {
  const path = join(cwd, edit.file);
  const f = Bun.file(path);

  if (!(await f.exists())) {
    return { ok: false, file: edit.file, reason: EDIT_FAIL_REASON.missingFile };
  }

  if (edit.oldString === "") {
    return { ok: false, file: edit.file, reason: EDIT_FAIL_REASON.notFound };
  }

  const content = await f.text();
  const matches = content.split(edit.oldString).length - 1;

  if (matches === 0) {
    return { ok: false, file: edit.file, reason: EDIT_FAIL_REASON.notFound };
  }

  if (matches > 1) {
    return {
      ok: false,
      file: edit.file,
      reason: EDIT_FAIL_REASON.ambiguous,
      matches,
    };
  }

  // Unique match: split/join avoids `$`-pattern interpretation in newString.
  await Bun.write(path, content.split(edit.oldString).join(edit.newString));

  return { ok: true, file: edit.file };
}

/**
 * Apply a SEQUENCE of str_replace edits to one file, ATOMICALLY: each match must
 * be exact and unique in the content as it stands after the prior replacements;
 * if any one fails, NOTHING is written and the failing replacement's index +
 * reason is returned. This lets the model fix the same issue at several spread-
 * out sites in a single turn (each piece still surgical) instead of a whole-file
 * rewrite — while the all-or-nothing write keeps a half-applied batch off disk.
 */
export async function applyEdits(
  cwd: string,
  file: string,
  edits: readonly IReplacement[]
): Promise<EditsResult> {
  const path = join(cwd, file);
  const f = Bun.file(path);

  if (!(await f.exists())) {
    return { ok: false, file, index: 0, reason: EDIT_FAIL_REASON.missingFile };
  }

  if (edits.length === 0) {
    return { ok: false, file, index: 0, reason: EDIT_FAIL_REASON.notFound };
  }

  let content = await f.text();

  for (let i = 0; i < edits.length; i += 1) {
    const replacement = edits[i];

    if (replacement === undefined || replacement.oldString === "") {
      return { ok: false, file, index: i, reason: EDIT_FAIL_REASON.notFound };
    }

    const matches = content.split(replacement.oldString).length - 1;

    if (matches === 0) {
      // Exact match failed — try an indentation-tolerant LINE match (the common
      // LLM miss: right code, slightly-off leading whitespace). Applies ONLY on a
      // unique window; never guesses. The gate re-validates as a backstop.
      const fuzzy = fuzzyLineReplace(
        content,
        replacement.oldString,
        replacement.newString
      );

      if (fuzzy.matches === 1) {
        content = fuzzy.text;
        continue;
      }

      if (fuzzy.matches > 1) {
        return {
          ok: false,
          file,
          index: i,
          reason: EDIT_FAIL_REASON.ambiguous,
          matches: fuzzy.matches,
        };
      }

      return { ok: false, file, index: i, reason: EDIT_FAIL_REASON.notFound };
    }

    if (matches > 1) {
      return {
        ok: false,
        file,
        index: i,
        reason: EDIT_FAIL_REASON.ambiguous,
        matches,
      };
    }

    content = content.split(replacement.oldString).join(replacement.newString);
  }

  await Bun.write(path, content);

  return { ok: true, file, count: edits.length };
}

/**
 * Indentation-tolerant line match: compare `oldString` to `content` line-by-line
 * ignoring each line's leading/trailing whitespace. Returns the new content with
 * the matched window replaced by `newString` — but ONLY when exactly one window
 * matches (`matches === 1`); 0 or >1 leaves content untouched so the caller can
 * report not-found/ambiguous rather than guess. Line-granular (not char-offset),
 * which keeps it simple and safe.
 */
function fuzzyLineReplace(
  content: string,
  oldString: string,
  newString: string
): { text: string; matches: number } {
  const norm = (s: string): string => s.trim();
  // Preserve the file's native line ending. Splitting on /\r?\n/ strips any \r
  // from existing lines, and rebuilding with the detected EOL gives uniform
  // endings — otherwise a CRLF file gets `\n`-only new lines spliced into
  // `\r\n` surroundings (mixed endings). See issue #24.
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const contentLines = content.split(/\r?\n/);
  const oldLines = oldString.split(/\r?\n/);

  // Drop blank leading/trailing lines (the model often adds a stray newline).
  while (oldLines.length > 0 && norm(oldLines[0] ?? "") === "") {
    oldLines.shift();
  }

  while (
    oldLines.length > 0 &&
    norm(oldLines[oldLines.length - 1] ?? "") === ""
  ) {
    oldLines.pop();
  }

  if (oldLines.length === 0) {
    return { text: content, matches: 0 };
  }

  const needle = oldLines.map(norm);
  const starts: number[] = [];

  for (let i = 0; i + needle.length <= contentLines.length; i += 1) {
    let hit = true;

    for (let j = 0; j < needle.length; j += 1) {
      if (norm(contentLines[i + j] ?? "") !== needle[j]) {
        hit = false;
        break;
      }
    }

    if (hit) {
      starts.push(i);
    }
  }

  if (starts.length !== 1) {
    return { text: content, matches: starts.length };
  }

  const start = starts[0] ?? 0;
  const rebuilt = [
    ...contentLines.slice(0, start),
    // An empty newString DELETES the matched window — `"".split()` yields `[""]`,
    // which would leave a stray blank line, so insert nothing instead.
    ...(newString === "" ? [] : newString.split(/\r?\n/)),
    ...contentLines.slice(start + needle.length),
  ];

  return { text: rebuilt.join(eol), matches: 1 };
}
