/**
 * A file the source-text meta-rules should scan: a `.ts`/`.tsx` file that isn't
 * generated. A `*.gen.ts` file ships its own blanket eslint-disable banner and
 * `@ts-nocheck` (e.g. TanStack's route tree) and is vendored — the model can't author it — so
 * the disable/suppression bans must skip it to stay airtight where it matters.
 *
 * The source-text rules iterate `changedFiles` (change-scoped — never the full
 * tree), so each rule self-checks the path here rather than trusting an upstream
 * file walk to pre-filter. Mirrors the `isSource` predicate in the write-guard.
 */
export function isScannableSource(path: string): boolean {
  return /\.tsx?$/u.test(path) && !path.endsWith(".gen.ts");
}
