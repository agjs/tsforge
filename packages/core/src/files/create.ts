import { join } from "node:path";
import type { CreateResult, ICreateFile } from "./types";

/**
 * Create a new file. Refuses to overwrite an existing one (that's `edit`'s job)
 * so the model can't silently clobber work. Parent dirs are created as needed.
 */
export async function applyCreate(
  cwd: string,
  create: ICreateFile
): Promise<CreateResult> {
  const path = join(cwd, create.file);

  if (await Bun.file(path).exists()) {
    return { ok: false, file: create.file, reason: "exists" };
  }

  await Bun.write(path, create.content);

  return { ok: true, file: create.file };
}
