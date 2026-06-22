import { join } from "node:path";

/** A snapshot of file contents keyed by workspace-relative path. */
export type FileSnapshot = Map<string, string>;

/**
 * Capture the current contents of `files` (skipping ones that don't exist), so a
 * later `restoreFiles` can roll an edit batch back verbatim. The shared substrate
 * for every "try an edit, keep only if it helps" loop (quality repair, review
 * repair) — one definition so the revert semantics can't drift between them.
 */
export async function snapshotFiles(
  cwd: string,
  files: readonly string[]
): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = new Map();

  for (const file of files) {
    const handle = Bun.file(join(cwd, file));

    if (await handle.exists()) {
      snapshot.set(file, await handle.text());
    }
  }

  return snapshot;
}

/** Write every captured file back to disk — the rollback half of a snapshot. */
export async function restoreFiles(
  cwd: string,
  snapshot: FileSnapshot
): Promise<void> {
  for (const [file, content] of snapshot) {
    await Bun.write(join(cwd, file), content);
  }
}
