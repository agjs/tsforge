// Build the ANSI-escape matcher from the ESC code point so the source carries no
// literal control char (a regex literal with \x1b trips no-control-regex).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Normalize one line of composed gate output into a stable comparison key:
 *  strip ANSI, remove the clone's absolute path (so signatures are portable),
 *  drop bun's per-test timing suffix, and collapse whitespace. */
function normalize(raw: string, cwd: string): string {
  return raw
    .replace(ANSI, "")
    .split(cwd)
    .join("")
    .replace(/\[\d+(?:\.\d+)?ms\]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract a set of FAILURE SIGNATURES from a composed BoringStack gate run
 * (`bun test` + `tsc` + `eslint`, all interleaved). Each signature identifies one
 * distinct failure so two gate runs can be diffed: a feature is judged only on the
 * failures it NEWLY introduces, not on pre-existing baseline failures in files it
 * is frozen out of.
 *
 * Recognized failure lines:
 *  - `(fail) <describe> > <test>`  — a bun test failure
 *  - `… error TS####: …`           — a tsc type error (carries its file)
 *  - `L:C  error  <msg>  <rule>`    — an eslint error row
 */
/** A knip section header line, e.g. `Unused files (1)` / `Unused dependencies (2)`.
 *  Ends an in-progress "Unused files" path list. */
function isKnipSectionHeader(line: string): boolean {
  return /^(Unused|Unlisted|Unresolved|Duplicate)\b.*\(\d+\)$/u.test(line);
}

/** A bun-test / tsc / eslint failure row (each a distinct, stable signature). */
function isErrorLine(line: string): boolean {
  return (
    line.startsWith("(fail)") ||
    /error TS\d+/u.test(line) ||
    /^\d+:\d+ error\b/u.test(line)
  );
}

/** App-qualify a stage-relative path using the current `::tsforge-app <prefix>::`
 *  marker. knip run inside `apps/api` prints `src/api/note/…`; the loop needs the
 *  repo-relative `apps/api/src/api/note/…` so the path matches the model's editable
 *  scope (else feedback drops it as read-only). `.`/empty/already-qualified → as-is. */
function qualify(app: string, relPath: string): string {
  if (app === "" || app === "." || relPath.startsWith(`${app}/`)) {
    return relPath;
  }

  return `${app}/${relPath}`;
}

export function extractFailures(output: string, cwd: string): Set<string> {
  const signatures = new Set<string>();
  // knip prints `Unused files (N)` then one relative path per line, ending at the
  // next command echo (`$ …`), a blank line, or another section header. Each path
  // becomes a stable actionable signature (`knip:unused-file:<repo-relative path>`)
  // so the differential + fingerprint can track it and the loop can steer on it —
  // instead of the whole block collapsing into one opaque `gate-nonzero` fallback
  // (which is exactly why an unused-file wall ground a live run for 130+ turns).
  let inUnusedFiles = false;
  let app = "";

  for (const rawLine of output.split("\n")) {
    const line = normalize(rawLine, cwd);

    const marker = /^::tsforge-app (.+)::$/u.exec(line);

    if (marker !== null) {
      app = marker[1] ?? "";
      inUnusedFiles = false;
      continue;
    }

    if (/^Unused files \(\d+\)$/u.test(line)) {
      inUnusedFiles = true;
      continue;
    }

    if (inUnusedFiles) {
      const ends =
        line.length === 0 || line.startsWith("$") || isKnipSectionHeader(line);

      if (!ends) {
        signatures.add(`knip:unused-file:${qualify(app, line)}`);
        continue;
      }

      inUnusedFiles = false;
    }

    if (line.length > 0 && isErrorLine(line)) {
      signatures.add(line);
    }
  }

  return signatures;
}

/** The failures present in `current` that are NOT in `baseline` — i.e. the ones a
 *  feature actually introduced. Baseline failures (pre-existing scaffold/base-suite
 *  defects the model cannot touch) are excluded so they never wedge a build. */
export function novelFailures(
  current: ReadonlySet<string>,
  baseline: ReadonlySet<string>
): string[] {
  return [...current].filter((signature) => !baseline.has(signature));
}
