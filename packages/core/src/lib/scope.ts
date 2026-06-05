/** True when `file` matches any of the glob `patterns` (the editable scope). */
export function isInScope(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(file));
}
