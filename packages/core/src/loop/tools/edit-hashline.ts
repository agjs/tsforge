import {
  applyHashlineEdit,
  parseHashlineEdit,
  SessionSnapshotStore,
} from "../../files/hashline";
import { extractHash } from "../../files/hashline-format";
import { parseOrRepair, reject, type IToolContext } from "./tool-context";
import { toHashlineEdit } from "../../agent";
import { writable, normalizeWorkspacePath } from "../../lib/scope";

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

  // Same write policy as `edit`/`create` (file-ops): normalize the path, then
  // refuse anything outside the editable scope. Without this `edit_lines` was a
  // hole — a `../` path reached applyHashlineEdit unchecked.
  edit.file = normalizeWorkspacePath(ctx.cwd, edit.file);

  if (!writable(edit.file, ctx.files)) {
    return reject(
      ctx,
      "edit_lines",
      `edit_lines ${edit.file} REJECTED: out of scope. You may only edit/create: ${ctx.files.join(", ")} (or throwaway files under scratch/).`
    );
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

  // Hash source priority: the `¶path#HASH` header the model wrote in `input`
  // (the format it saw on read), else the `hash` arg — tolerantly extracted so
  // a pasted full tag (`¶path#HASH`) still yields the bare hash. Using the raw
  // arg directly caused false stale-anchor rejections on unchanged files.
  const fileHash = parsed.fileHash ?? extractHash(edit.hash);

  const result = await applyHashlineEdit(
    ctx.snapshotStore,
    ctx.cwd,
    edit.file,
    fileHash,
    parsed.ops
  );

  if (result.ok) {
    // A no-op edit (ops resolved to identical content) wrote nothing — report NO
    // mutation event so it can't trigger a re-gate or count toward "done".
    if (result.changed !== true) {
      return `edit_lines ${edit.file}: no change — the ops resolved to identical content. Move on to the next fix or run the gate.`;
    }

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
