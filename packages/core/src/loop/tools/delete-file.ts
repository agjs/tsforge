import { rm, stat } from "node:fs/promises";
import { relative, isAbsolute, join } from "node:path";

import {
  reject,
  resolveWritable,
  str,
  type IToolContext,
} from "./tool-context";

/**
 * Delete ONE in-scope file.
 *
 * The shell's `rm` is a critical deny in every policy mode, and rightly so — an
 * agent running `rm -rf` is unrecoverable. But that denial is a blunt head
 * match, so it also blocked deleting a single file the model had just
 * superseded. A logged refactor hit exactly that: after moving `GamerCard.tsx`
 * into its own folder the model tried `rm src/features/feed/GamerCard.tsx`
 * twice, was denied both times, and left a re-export shim behind as dead code.
 *
 * This is the narrow primitive that denial assumed existed: one path, no globs,
 * no directories, no recursion, and the SAME editable-scope check `create` and
 * `edit` use — so it can only ever remove a file the model was already allowed
 * to overwrite. `rm` stays banned; nothing here widens the shell.
 */
export async function doDeleteFile(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const raw = str(args, "file").trim();

  if (raw.length === 0) {
    return reject(ctx, "delete", "delete: `file` is required.");
  }

  // Globs would turn one mistake into many; the whole point of this tool over
  // `rm` is that its blast radius is exactly one named file.
  if (/[*?[\]]/u.test(raw)) {
    return reject(
      ctx,
      "delete",
      `delete ${raw} REJECTED: one file path only — no globs. Delete files one at a time.`
    );
  }

  const target = resolveWritable(ctx, raw);

  if (!target.writable) {
    return reject(
      ctx,
      "delete",
      `delete ${target.path} REJECTED: out of scope. You may only delete files you could edit: ${ctx.files.join(", ")}.`
    );
  }

  const abs = isAbsolute(target.path)
    ? target.path
    : join(ctx.cwd, target.path);
  // `stat`, not `Bun.file(...).exists()` — the latter reports FALSE for a
  // directory, which would report `src/` as "already gone" instead of refusing
  // it, and hide the mistake from the model.
  const info = await stat(abs).catch(() => null);

  if (info === null) {
    return `delete: ${target.path} does not exist (already gone — nothing to do).`;
  }

  // A directory delete is a different, far larger action than "remove the file I
  // just replaced", so it stays outside this tool rather than growing a flag.
  if (info.isDirectory()) {
    return reject(
      ctx,
      "delete",
      `delete ${target.path} REJECTED: that is a directory. This tool removes a single FILE.`
    );
  }

  await rm(abs, { force: true });
  // `mutated` (not a create/edit event): removing a file changes what compiles,
  // so the loop must re-gate — but nothing was written, so there is no per-write
  // guard to run over it.
  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `deleted ${target.path}`,
    mutated: [target.path],
  });

  return `deleted ${target.path}`;
}

/** Workspace-relative form for messages, when the path sits under cwd. */
export function displayPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);

  return rel.length > 0 && !rel.startsWith("..") ? rel : abs;
}
