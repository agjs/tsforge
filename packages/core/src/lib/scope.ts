/** A throwaway prefix the model may always write to — `scratch/` experiments are
 *  ignored by the gate, so it can test hypotheses by running code. */
export const SCRATCH_PREFIX = "scratch/";

/** True when `file` matches any of the glob `patterns` (the editable scope). */
export function isInScope(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(file));
}

/** A file the model may write: its editable scope, OR a throwaway scratch file. */
export function writable(file: string, patterns: string[]): boolean {
  return isInScope(file, patterns) || file.startsWith(SCRATCH_PREFIX);
}
