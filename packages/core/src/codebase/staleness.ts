import { join } from "node:path";
import { readFileSync } from "node:fs";
import { computeFileHash } from "../files/hashline-format";
import { runArgvCommand } from "../lib/fs";
import type { IWorkspaceMap } from "./codebase.types";

/** Per-file content hashes + a combined fingerprint over the given files. */
export function fingerprint(
  cwd: string,
  files: string[]
): { combined: string; perFile: Record<string, string> } {
  const perFile: Record<string, string> = {};

  for (const f of files) {
    perFile[f] = hashFile(cwd, f);
  }

  // Combine into one hash: stable order, path + hash per file.
  const combined = computeFileHash(
    Object.keys(perFile)
      .sort()
      .map((f) => `${f}:${perFile[f] ?? ""}`)
      .join("\n")
  );

  return { combined, perFile };
}

function hashFile(cwd: string, file: string): string {
  try {
    return computeFileHash(readFileSync(join(cwd, file), "utf8"));
  } catch {
    return "";
  }
}

/** Current git HEAD sha, or "" when not a repo / git absent. */
export async function gitHead(cwd: string): Promise<string> {
  const res = await runArgvCommand(cwd, ["git", "rev-parse", "HEAD"]);

  return res.exitCode === 0 ? res.stdout.trim() : "";
}

/** Mapped files whose content changed since the map was built. */
export function staleFiles(cwd: string, map: IWorkspaceMap): string[] {
  const files = Object.keys(map.fileHashes);
  const { perFile } = fingerprint(cwd, files);

  return files.filter((f) => perFile[f] !== map.fileHashes[f]);
}
