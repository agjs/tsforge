/**
 * A file the source-text meta-rules should scan: a TypeScript source file
 * (`.ts`/`.tsx`/`.mts`/`.cts`) that isn't generated. A generated `*.gen.{ts,tsx,mts,cts}`
 * ships its own blanket eslint-disable banner and `@ts-nocheck` (e.g. TanStack's
 * route tree) and is vendored — the model can't author it — so the
 * disable/suppression bans must skip it to stay airtight where it matters.
 *
 * The source-text rules iterate `changedFiles` (change-scoped — never the full
 * tree), so each rule self-checks the path here rather than trusting an upstream
 * file walk to pre-filter.
 */
export function isScannableSource(path: string): boolean {
  return /\.[cm]?tsx?$/u.test(path) && !/\.gen\.[cm]?tsx?$/u.test(path);
}
