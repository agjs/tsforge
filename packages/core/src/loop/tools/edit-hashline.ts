import {
  applyHashlineEdit,
  parseHashlineEdit,
  SessionSnapshotStore,
} from "../../files/hashline";
import { parseOrRepair, reject, type IToolContext } from "./tool-context";
import { toHashlineEdit } from "../../agent";

/**
 * Hashline edit handler: content-hash-anchored line edits with stale-anchor recovery.
 * Parses the input, applies ops bottom-up, and handles stale tags via snapshot-based
 * 3-way merge. The snapshot store lives on the session context.
 */
export async function doHashlineEdit(
  args: Record<string, unknown>,
  ctx: IToolContext & { snapshotStore?: SessionSnapshotStore }
): Promise<string> {
  const { value: edit, feedback } = parseOrRepair(
    args,
    toHashlineEdit,
    ctx,
    "edit_lines"
  );

  if (edit === null) {
    if (feedback !== undefined && feedback.length > 0) {
      return feedback;
    }

    return "edit_lines: malformed args (need `file` and `input`)";
  }

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `edit_lines ${edit.file}`,
  });

  // Parse the hashline input
  const parsed = parseHashlineEdit(edit.input);

  if (parsed.errors.length > 0) {
    return reject(
      ctx,
      "edit_lines:parse-error",
      `edit_lines ${edit.file} REJECTED: ${parsed.errors[0] ?? "unparseable edit"}`
    );
  }

  // Ensure the store exists on the context
  ctx.snapshotStore ??= new SessionSnapshotStore();

  const result = await applyHashlineEdit(
    ctx.snapshotStore,
    ctx.cwd,
    edit.file,
    edit.hash,
    parsed.ops
  );

  if (result.ok) {
    ctx.report({
      kind: "edit",
      task: ctx.task,
      file: edit.file,
      message: `edit_lines ${edit.file} (new hash #${result.newHash ?? "?"})`,
    });

    return `edited ${edit.file} (new hash #${result.newHash ?? "?"})`;
  }

  const feedbackText =
    result.suggestions?.[0] ?? result.reason ?? "unknown error";

  return reject(
    ctx,
    `edit_lines:${result.reason ?? "error"}`,
    `edit_lines ${edit.file} REJECTED: ${feedbackText}`
  );
}
