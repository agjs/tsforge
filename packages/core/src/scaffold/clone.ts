import type { IScaffoldRunner } from "./io";
import type { IArchetype } from "./scaffold.types";

/** Replay metadata recorded in the scaffolded project's `.tsforge/scaffold.json`
 *  — pins exactly which boringstack commit + archetype produced the project. */
export interface IScaffoldRecord {
  readonly source: string;
  readonly ref: string;
  readonly resolvedSha: string;
  readonly archetype: IArchetype;
  readonly manifestVersion: number;
}

export interface ICloneResult {
  readonly dir: string;
  readonly resolvedSha: string;
}

/** Shallow-clone `repo` at `ref` into `dest`, then resolve HEAD to a concrete sha
 *  for replay. Throws (with the git stderr) if the clone fails — a half-scaffold is
 *  worse than a clear stop. `ref` is a branch or tag (boringstack's `defaultRef`);
 *  shallow `--branch` doesn't take a bare sha, which is why the manifest pins a
 *  movable ref and we RECORD the resolved sha rather than clone one. */
export async function cloneRepo(
  repo: string,
  ref: string,
  dest: string,
  run: IScaffoldRunner
): Promise<ICloneResult> {
  const cloned = await run(".", [
    "git",
    "clone",
    "--depth",
    "1",
    "--branch",
    ref,
    "--single-branch",
    repo,
    dest,
  ]);

  if (cloned.exitCode !== 0) {
    throw new Error(
      `scaffold clone: git clone ${repo}@${ref} failed (exit ${String(cloned.exitCode)}): ${cloned.stderr.trim()}`
    );
  }

  const head = await run(dest, ["git", "rev-parse", "HEAD"]);

  if (head.exitCode !== 0) {
    throw new Error(
      `scaffold clone: could not resolve HEAD in ${dest}: ${head.stderr.trim()}`
    );
  }

  return { dir: dest, resolvedSha: head.stdout.trim() };
}

/** Build the replay record (pure — the caller writes it via the fs adapter). */
export function scaffoldRecord(record: IScaffoldRecord): IScaffoldRecord {
  return {
    source: record.source,
    ref: record.ref,
    resolvedSha: record.resolvedSha,
    archetype: record.archetype,
    manifestVersion: record.manifestVersion,
  };
}
