import { join } from "node:path";
import { CREATE_FAIL_REASON } from "./files.constants";
import type { CreateResult, ICreateFile } from "./files.types";

/**
 * Create a new file. Refuses to overwrite an existing one (that's `edit`'s job)
 * so the model can't silently clobber work — UNLESS `overwrite` is set, which the
 * caller passes only for a full rewrite of a file the model authored this session
 * (its own work, not pre-existing code). Parent dirs are created as needed.
 */
export async function applyCreate(
  cwd: string,
  create: ICreateFile,
  overwrite = false
): Promise<CreateResult> {
  const path = join(cwd, create.file);

  if (!overwrite && (await Bun.file(path).exists())) {
    return { ok: false, file: create.file, reason: CREATE_FAIL_REASON.exists };
  }

  await Bun.write(path, create.content);

  return { ok: true, file: create.file };
}
