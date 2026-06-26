import type { IScaffoldManifest } from "./scaffold.types";

/** Default key-families the completeness alarm watches when the manifest doesn't
 *  declare its own: boolean infra toggles and feature flags. */
const DEFAULT_WATCH = ["^WITH_", "_ENABLED$"] as const;

/** Every env var name referenced in a `.env.example` — from both live `KEY=…`
 *  lines and prose-commented `# … KEY=…` lines (boringstack documents toggles in
 *  comments, e.g. `# Disable with WITH_OBSERVABILITY=0`). De-duplicated. */
export function envKeysOf(text: string): readonly string[] {
  const keys = new Set<string>();

  // Strip a leading comment marker, then match an UPPER_SNAKE key immediately
  // followed by `=`. Scans every `KEY=` occurrence on the line (a comment can
  // mention the toggle inline), so `# Disable with WITH_OBSERVABILITY=0.` yields it.
  for (const line of text.split("\n")) {
    for (const m of line.matchAll(/\b([A-Z][A-Z0-9_]+)=/gu)) {
      const key = m[1];

      if (key !== undefined) {
        keys.add(key);
      }
    }
  }

  return [...keys];
}

/** Keys present in the env surface that MATCH a watched pattern but are NOT
 *  modelled by the manifest's `fields` — i.e. configurables the wizard would
 *  silently drop. Empty = the manifest fully covers the watched surface. This is
 *  the drift/completeness alarm; a non-empty result should FAIL a test/gate. */
export function coverageGaps(
  manifest: IScaffoldManifest,
  envText: string
): readonly string[] {
  const patterns = (manifest.watchPatterns ?? DEFAULT_WATCH).map(
    (p) => new RegExp(p, "u")
  );
  const ignored = (manifest.watchIgnore ?? []).map((p) => new RegExp(p, "u"));
  const covered = new Set(manifest.fields.map((f) => f.key));

  const gaps = envKeysOf(envText).filter(
    (key) =>
      patterns.some((re) => re.test(key)) &&
      !covered.has(key) &&
      !ignored.some((re) => re.test(key))
  );

  return [...new Set(gaps)].sort();
}
