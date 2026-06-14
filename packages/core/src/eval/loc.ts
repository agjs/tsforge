import { join } from "node:path";

/**
 * Lines-of-code counter — a cheap structural proxy for solution SIZE, used by the
 * eval sweep to measure concision (the axis the gate is blind to: it checks that
 * code is correct, never that it is lean).
 *
 * Counts non-blank, non-comment lines. This is deliberately a HEURISTIC (the
 * ponytail-benchmark approach), not a parse: block comments are stripped, then
 * blank lines and line-comment-only lines are dropped. A comment marker inside a
 * string literal is treated as a comment — acceptable, because LOC is only ever
 * compared between solutions to the SAME task, where that noise is constant.
 */
export function countLoc(content: string): number {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, "");

  return withoutBlocks
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//")).length;
}

/** Total + per-file LOC for a task's editable files. */
export interface ITaskLoc {
  totalLoc: number;
  perFile: Record<string, number>;
}

/**
 * Sum LOC across a task's editable `files` (resolved under `cwd`; glob patterns
 * are expanded, plain filenames match themselves). Run AFTER a green solution
 * exists, so it measures what the model actually shipped. A pattern that matches
 * nothing contributes 0.
 */
export async function countTaskLoc(
  cwd: string,
  patterns: readonly string[]
): Promise<ITaskLoc> {
  const perFile: Record<string, number> = {};

  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);

    for await (const rel of glob.scan({ cwd, onlyFiles: true })) {
      if (rel in perFile) {
        continue;
      }

      perFile[rel] = countLoc(await Bun.file(join(cwd, rel)).text());
    }
  }

  const totalLoc = Object.values(perFile).reduce((acc, n) => acc + n, 0);

  return { totalLoc, perFile };
}
