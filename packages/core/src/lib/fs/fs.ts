import { join } from "node:path";
import type { IFileView } from "./fs.types";

/** True when the file exists on disk (the one place this check lives). */
export function fileExists(cwd: string, path: string): Promise<boolean> {
  return Bun.file(join(cwd, path)).exists();
}

/** Read the given paths that exist, in order, as {path, content} views. */
export async function readFiles(
  cwd: string,
  paths: readonly string[]
): Promise<IFileView[]> {
  const views: IFileView[] = [];

  for (const path of paths) {
    const file = Bun.file(join(cwd, path));

    if (await file.exists()) {
      views.push({ path, content: await file.text() });
    }
  }

  return views;
}
