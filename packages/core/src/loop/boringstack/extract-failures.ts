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
export function extractFailures(output: string, cwd: string): Set<string> {
  const signatures = new Set<string>();

  for (const rawLine of output.split("\n")) {
    const line = normalize(rawLine, cwd);

    if (line.length === 0) {
      continue;
    }

    const isTestFail = line.startsWith("(fail)");
    const isTscError = /error TS\d+/.test(line);
    const isEslintError = /^\d+:\d+ error\b/.test(line);

    if (isTestFail || isTscError || isEslintError) {
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
