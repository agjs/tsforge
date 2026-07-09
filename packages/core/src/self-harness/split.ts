/**
 * Held-in / held-out task splits over `evals/corpus/*`. The held-in split
 * supplies failure evidence to the proposer; the held-out split is NEVER shown
 * to it and gates every promotion (the paper's overfitting guard). Assignment
 * is fixed and deterministic — never derived from run outcomes.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ISplits } from "./self-harness.types";

/** Fixed default assignment over the 12 corpus tasks. Held-out mixes a
 *  multi-file greenfield task (auth), the only brownfield task
 *  (fix-regression), and two single-module tasks — so a promoted edit must
 *  generalize across task shapes it never saw evidence from. */
export const DEFAULT_HELD_IN = [
  "checkout",
  "debounce",
  "fixtures",
  "handlers",
  "math",
  "migrate",
  "slugify",
  "validators",
] as const;

export const DEFAULT_HELD_OUT = [
  "auth",
  "fix-regression",
  "query",
  "rate-limit",
] as const;

/** All corpus task ids (directories containing `<id>.spec.md`). */
export async function listCorpusTasks(corpusDir: string): Promise<string[]> {
  const entries = await readdir(corpusDir, { withFileTypes: true });
  const ids: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (
      await Bun.file(
        join(corpusDir, entry.name, `${entry.name}.spec.md`)
      ).exists()
    ) {
      ids.push(entry.name);
    }
  }

  return ids.sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve the splits: explicit lists win (validated against the corpus),
 * otherwise the fixed defaults filtered to tasks that exist. Throws on an
 * unknown task id, an overlapping assignment, or an empty split — a silent
 * misassignment would invalidate every acceptance decision downstream.
 */
export async function resolveSplits(
  corpusDir: string,
  heldIn?: readonly string[],
  heldOut?: readonly string[]
): Promise<ISplits> {
  const available = new Set(await listCorpusTasks(corpusDir));
  const inIds = [
    ...(heldIn ?? DEFAULT_HELD_IN.filter((t) => available.has(t))),
  ];
  const outIds = [
    ...(heldOut ?? DEFAULT_HELD_OUT.filter((t) => available.has(t))),
  ];

  for (const id of [...inIds, ...outIds]) {
    if (!available.has(id)) {
      throw new Error(
        `unknown corpus task "${id}" — available: ${[...available].join(", ")}`
      );
    }
  }

  const overlap = inIds.filter((id) => outIds.includes(id));

  if (overlap.length > 0) {
    throw new Error(
      `task(s) in BOTH splits: ${overlap.join(", ")} — splits must be disjoint`
    );
  }

  if (inIds.length === 0 || outIds.length === 0) {
    throw new Error("both splits must be non-empty");
  }

  return { heldIn: inIds, heldOut: outIds };
}
