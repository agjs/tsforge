import { join } from "node:path";
import { EDIT_FAIL_REASON } from "./files.constants";
import type {
  EditResult,
  EditsResult,
  IEdit,
  IReplacement,
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
  const next = content.split(edit.oldString).join(edit.newString);

  // A same-content replacement (oldString === newString, or it was already
  // applied) leaves the file byte-identical. Skip the write and flag it so the
  // caller doesn't count a no-op as a mutation or trigger a needless re-gate.
  if (next === content) {
    return { ok: true, file: edit.file, changed: false };
  }

  await Bun.write(path, next);

  return { ok: true, file: edit.file, changed: true };
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

  const original = await f.text();
  let content = original;

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

  // A batch that resolves to byte-identical content (all replacements were no-ops
  // or already applied) must not be counted as a mutation — skip the write and
  // flag it so the caller neither re-gates nor tallies a phantom edit.
  if (content === original) {
    return { ok: true, file, count: edits.length, changed: false };
  }

  await Bun.write(path, content);

  return { ok: true, file, count: edits.length, changed: true };
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
  // Normalize a line for COMPARISON only (the matched window is replaced verbatim
  // with newString, and the gate/formatter re-validate). Beyond leading/trailing
  // whitespace we also (a) collapse internal whitespace runs and (b) unify quote
  // styles — the two cosmetic drifts a local model reliably gets wrong: it writes
  // `'@/x'` against a prettier-formatted `"@/x"`, or `foo( a, b )` vs `foo(a, b)`.
  // Exact match is tried FIRST (caller), so this only widens genuine misses; the
  // unique-window guard below still blocks any ambiguous match.
  const norm = (s: string): string =>
    s
      // Unicode fold FIRST (LLM/paste output emits these): NFKC, then curly quotes
      // → straight, Unicode dashes → `-`, exotic spaces (NBSP, ideographic) → space.
      .normalize("NFKC")
      .replace(/[‘’‚‛]/gu, "'")
      .replace(/[“”„‟]/gu, '"')
      .replace(/[‐-―−]/gu, "-")
      .replace(/[  -   　]/gu, " ")
      .trim()
      .replace(/['"`]/gu, '"') // unify quote style (straight + the folded curly)
      .replace(/\s+/gu, " ") // collapse internal whitespace runs
      .replace(/\s*([^\w\s])\s*/gu, "$1"); // drop whitespace AROUND punctuation
  // ^ `foo( a, b )`, `foo(a,b)`, and `foo(a, b)` all normalize equal, but two
  //   identifiers keep their separating space (`const x` never becomes `constx`),
  //   so the match stays meaningful. Unique-window guard still blocks ambiguity.
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
