import { join } from "node:path";
import {
  applyHashlineEdit,
  parseHashlineEdit,
  SessionSnapshotStore,
} from "../../files/hashline";
import { extractHash } from "../../files/hashline-format";
import { syntaxErrorCount } from "../../files/syntax-check";
import {
  parseOrRepair,
  reject,
  guardVeto,
  type IToolContext,
  resolveWritable,
} from "./tool-context";
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

  // Same write policy as `edit`/`create` (file-ops): normalize the path, then
  // refuse anything outside the editable scope. Without this `edit_lines` was a
  // hole — a `../` path reached applyHashlineEdit unchecked.
  const target = resolveWritable(ctx, edit.file);

  edit.file = target.path;

  if (!target.writable) {
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
  const snapshotStore = (ctx.snapshotStore ??= new SessionSnapshotStore());

  // Hash source priority: the `¶path#HASH` header the model wrote in `input`
  // (the format it saw on read), else the `hash` arg — tolerantly extracted so
  // a pasted full tag (`¶path#HASH`) still yields the bare hash. Using the raw
  // arg directly caused false stale-anchor rejections on unchanged files.
  const fileHash = parsed.fileHash ?? extractHash(edit.hash);

  const result = await applyHashlineEdit(
    snapshotStore,
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

    // SYNTAX-REGRESSION GUARD: unlike `edit` (which rejects too-large/oldString
    // mismatches BEFORE writing), a well-formed, correctly-anchored hashline edit
    // commits unconditionally — so a mis-addressed op silently corrupts the file
    // (top-of-file TS1xxx parse errors), and the model then edits the broken file,
    // thrashing. Worse, tsc masks the file's real semantic errors behind the parse
    // error, so the model sees 1-2 errors instead of the true 20+. If THIS edit
    // INTRODUCED new syntax errors, revert to the pre-edit content and steer the
    // model to re-read. Guarded on an INCREASE (not "any error") so it never traps
    // the model on a file that was already broken.
    const before = syntaxErrorCount(edit.file, result.previousContent ?? "");
    const after = syntaxErrorCount(edit.file, result.newContent ?? "");

    if (after > before) {
      const prev = result.previousContent ?? "";

      await Bun.write(join(ctx.cwd, edit.file), prev);
      snapshotStore.record(edit.file, prev);

      return reject(
        ctx,
        "edit_lines:syntax-regression",
        `edit_lines ${edit.file} REVERTED: your edit introduced ${String(after - before)} new syntax error(s) — the file no longer parses, so it was rolled back to its previous content. Your line ops likely landed on the wrong lines. \`read\` ${edit.file} again to get fresh line anchors, then make a SMALL, targeted edit of only the broken lines.`
      );
    }

    // Same edit guard as `edit`: this mutation path must not be a bypass. A veto
    // reverts to the pre-edit content (and re-records the snapshot) and returns
    // the guard's rejection. Only runs when the apply gave us BOTH before and
    // after — passing "" for a missing side would feed the guard invalid content
    // (JSON.parse("") throws → fails open), silently skipping the veto. Skip
    // instead, symmetric with doEdit's readFileTextOrNull short-circuit.
    const guardBefore = result.previousContent;
    const guardAfter = result.newContent;
    const veto =
      guardBefore === undefined || guardAfter === undefined
        ? null
        : guardVeto(ctx, edit.file, guardBefore, guardAfter);

    if (veto !== null) {
      await Bun.write(join(ctx.cwd, edit.file), guardBefore ?? "");
      snapshotStore.record(edit.file, guardBefore ?? "");

      return reject(ctx, `edit_lines:${veto.reason}`, veto.message);
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
