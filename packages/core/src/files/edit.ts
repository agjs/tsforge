import { join } from "node:path";
import type { IEdit, EditResult, IReplacement, EditsResult } from "./types";

/**
 * Apply a str_replace edit. The match must be **exact and unique** — 0 matches
 * is `not-found`, >1 is `ambiguous` (the model must add surrounding context).
 * Uniqueness is what makes blind edits safe for a strong, full-file-context model.
 */
export async function applyEdit(cwd: string, edit: IEdit): Promise<EditResult> {
  const path = join(cwd, edit.file);
  const f = Bun.file(path);

  if (!(await f.exists())) {
    return { ok: false, file: edit.file, reason: "missing-file" };
  }

  if (edit.oldString === "") {
    return { ok: false, file: edit.file, reason: "not-found" };
  }

  const content = await f.text();
  const matches = content.split(edit.oldString).length - 1;

  if (matches === 0) {
    return { ok: false, file: edit.file, reason: "not-found" };
  }

  if (matches > 1) {
    return { ok: false, file: edit.file, reason: "ambiguous", matches };
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
    return { ok: false, file, index: 0, reason: "missing-file" };
  }

  if (edits.length === 0) {
    return { ok: false, file, index: 0, reason: "not-found" };
  }

  let content = await f.text();

  for (let i = 0; i < edits.length; i += 1) {
    const replacement = edits[i];

    if (replacement === undefined || replacement.oldString === "") {
      return { ok: false, file, index: i, reason: "not-found" };
    }

    const matches = content.split(replacement.oldString).length - 1;

    if (matches === 0) {
      return { ok: false, file, index: i, reason: "not-found" };
    }

    if (matches > 1) {
      return { ok: false, file, index: i, reason: "ambiguous", matches };
    }

    content = content.split(replacement.oldString).join(replacement.newString);
  }

  await Bun.write(path, content);

  return { ok: true, file, count: edits.length };
}
