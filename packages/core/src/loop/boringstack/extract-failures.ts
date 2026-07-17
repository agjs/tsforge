import type { IFailureParserState } from "./extract-failures.types";

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
 * eslint's stylish formatter renders a MULTI-LINE rule message across several lines:
 * the `L:C error <first line>` row, then the raw continuation lines, with the ruleId
 * appended (after 2+ spaces of padding) to the LAST line. Example (module-boundaries
 * `single-semantic-module`):
 *
 *   6:8  error  Mixed semantic categories detected in module:
 *   - function
 *   - class
 *
 *   A module must contain only one semantic concern.
 *   Move declarations into separate files/modules  module-boundaries/single-semantic-module
 *
 * The per-line parser would keep only the first line (and miss the ruleId), so the
 * model sees a truncated, unactionable message ("…detected in module:" — no categories,
 * no fix) and sprays near-green (observed live). Collapse each such multi-line row into
 * ONE line so the full message + ruleId parse. Single-line rows (message + ruleId
 * already together) pass through untouched.
 */
function joinMultilineEslintRows(output: string): string {
  const lines = output.split("\n");
  const plain = (s: string): string => s.replace(ANSI, "");
  const isErrorStart = (s: string): boolean =>
    /^\s*\d+:\d+\s+error\s/u.test(plain(s));
  // A join TERMINATOR is eslint's padded ruleId column: 2+ spaces then a
  // PLUGIN-qualified id (contains `/`, e.g. `module-boundaries/single-semantic-module`
  // or `@typescript-eslint/x`). Requiring the slash avoids a prose continuation like
  // `Do not use  console` being mistaken for a ruleId and terminating early.
  const endsWithRuleId = (s: string): boolean =>
    /\S {2,}@?[\w-]+\/[\w@/-]+\s*$/u.test(plain(s));

  // A BOUNDARY stops the join WITHOUT being consumed — the multi-line message can't
  // legitimately cross it: a new error row, a source-file header (a path ending in
  // .ts/.tsx), an `::tsforge-app::` stage marker, or a `$` command echo. This stops
  // a rule-LESS row (e.g. a `Parsing error`, which carries no ruleId) from swallowing
  // the next file's header + diagnostics.
  const isBoundary = (s: string): boolean => {
    const p = plain(s).trim();

    return (
      isErrorStart(s) ||
      p.startsWith("$") ||
      /^::tsforge-app .+::$/u.test(p) ||
      /\.[cm]?[jt]sx?:?$/u.test(p)
    );
  };

  const MAX_SPAN = 15;

  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const start = lines[i] ?? "";

    // Not a multi-line START (either not an error row, or already a complete
    // single-line row with its ruleId) → pass through.
    if (!isErrorStart(start) || endsWithRuleId(start)) {
      out.push(start);
      continue;
    }

    // Scan forward for the ruleId terminator, but STOP at a boundary or the span cap.
    // Only collapse when a terminator is actually found — otherwise a rule-less error
    // (parse error) or an unterminated block is emitted UNCHANGED (old per-line
    // behavior), so nothing downstream is swallowed.
    let j = i + 1;

    while (
      j < lines.length &&
      j - i <= MAX_SPAN &&
      !endsWithRuleId(lines[j] ?? "") &&
      !isBoundary(lines[j] ?? "")
    ) {
      j += 1;
    }

    if (
      j < lines.length &&
      j - i <= MAX_SPAN &&
      endsWithRuleId(lines[j] ?? "")
    ) {
      out.push(lines.slice(i, j + 1).join(" "));
      i = j;
    } else {
      out.push(start);
    }
  }

  return out.join("\n");
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

/** Encode a parsed failure as one stable string so the pristine-baseline Set can
 * still diff it without throwing away the location fields the repair loop needs. */
function structuredFailure(
  file: string,
  line: number | undefined,
  rule: string,
  message: string
): string {
  return [
    "failure",
    encodeURIComponent(file),
    line === undefined ? "" : String(line),
    encodeURIComponent(rule),
    encodeURIComponent(message),
  ].join(":");
}

/** A source-file header printed before bun/eslint/lint-meta diagnostics. */
function sourceFileFromLine(line: string, app: string): string | null {
  const withoutColon = line.endsWith(":") ? line.slice(0, -1) : line;

  if (!/\.[cm]?[jt]sx?$/u.test(withoutColon)) {
    return null;
  }

  const relative = withoutColon.replace(/^\.\//u, "").replace(/^\//u, "");

  return qualify(app, relative);
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

function consumeMarker(line: string, state: IFailureParserState): boolean {
  const marker = /^::tsforge-app (.+)::$/u.exec(line);

  if (marker === null) {
    return false;
  }

  state.app = marker[1] ?? "";
  state.inUnusedFiles = false;
  state.inLintMeta = false;
  state.currentFile = "";

  return true;
}

function consumeKnip(
  line: string,
  state: IFailureParserState,
  signatures: Set<string>
): boolean {
  if (/^Unused files \(\d+\)$/u.test(line)) {
    state.inUnusedFiles = true;

    return true;
  }

  if (!state.inUnusedFiles) {
    return false;
  }

  const ends =
    line.length === 0 || line.startsWith("$") || isKnipSectionHeader(line);

  if (ends) {
    state.inUnusedFiles = false;

    return false;
  }

  signatures.add(`knip:unused-file:${qualify(state.app, line)}`);

  return true;
}

function consumeLintMeta(
  line: string,
  state: IFailureParserState,
  signatures: Set<string>
): boolean {
  if (/^\[lint:meta\] \d+ violation\(s\):$/u.test(line)) {
    state.inLintMeta = true;
    state.currentFile = "";

    return true;
  }

  if (line === "[lint:meta] No violations.") {
    state.inLintMeta = false;
    state.currentFile = "";

    return true;
  }

  if (!state.inLintMeta || state.currentFile === "") {
    return false;
  }

  if (line.startsWith('error: script "lint:meta"')) {
    state.inLintMeta = false;
    state.currentFile = "";

    return false;
  }

  const violation = /^([\w@/-]+): (.+)$/u.exec(line);

  if (violation === null) {
    return false;
  }

  signatures.add(
    structuredFailure(
      state.currentFile,
      undefined,
      violation[1] ?? "lint-meta",
      violation[2] ?? line
    )
  );

  return true;
}

function consumeSourceFile(line: string, state: IFailureParserState): boolean {
  const sourceFile = sourceFileFromLine(line, state.app);

  if (sourceFile === null) {
    return false;
  }

  state.currentFile = sourceFile;

  return true;
}

function parsedDiagnostic(
  line: string,
  state: IFailureParserState
): string | null {
  const typeError = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.+)$/u.exec(line);

  if (typeError !== null) {
    const file = qualify(
      state.app,
      (typeError[1] ?? "").replace(/^\.\//u, "").replace(/^\//u, "")
    );

    return structuredFailure(
      file,
      Number(typeError[2] ?? "0"),
      typeError[4] ?? "tsc",
      typeError[5] ?? line
    );
  }

  // An eslint PARSING error carries no ruleId — the row is `L:C error Parsing
  // error: <detail>`. normalize() has already collapsed the multi-space gap that
  // separates an eslint message from its trailing ruleId, so the generic row
  // regex below would grab the message's last word (`… ';' expected` → rule
  // `expected`) and mint a phantom rule. Capture these as `syntax` (matching the
  // tsc-parser convention) so no message word ever masquerades as a rule id.
  const eslintParseError = /^(\d+):(\d+) error (Parsing error:.*)$/u.exec(line);

  if (eslintParseError !== null && state.currentFile !== "") {
    return structuredFailure(
      state.currentFile,
      Number(eslintParseError[1] ?? "0"),
      "syntax",
      eslintParseError[3] ?? line
    );
  }

  const eslintError = /^(\d+):(\d+) error (.+?) ([\w@/-]+)$/u.exec(line);

  if (eslintError !== null && state.currentFile !== "") {
    return structuredFailure(
      state.currentFile,
      Number(eslintError[1] ?? "0"),
      eslintError[4] ?? "eslint",
      eslintError[3] ?? line
    );
  }

  if (line.startsWith("(fail)") && state.currentFile !== "") {
    return structuredFailure(state.currentFile, undefined, "bun-test", line);
  }

  return line.length > 0 && isErrorLine(line) ? line : null;
}

export function extractFailures(output: string, cwd: string): Set<string> {
  const signatures = new Set<string>();
  // knip prints `Unused files (N)` then one relative path per line, ending at the
  // next command echo (`$ …`), a blank line, or another section header. Each path
  // becomes a stable actionable signature (`knip:unused-file:<repo-relative path>`)
  // so the differential + fingerprint can track it and the loop can steer on it —
  // instead of the whole block collapsing into one opaque `gate-nonzero` fallback
  // (which is exactly why an unused-file wall ground a live run for 130+ turns).
  const state: IFailureParserState = {
    app: "",
    currentFile: "",
    inLintMeta: false,
    inUnusedFiles: false,
  };

  for (const rawLine of joinMultilineEslintRows(output).split("\n")) {
    const line = normalize(rawLine, cwd);

    if (consumeMarker(line, state)) {
      continue;
    }

    if (consumeKnip(line, state, signatures)) {
      continue;
    }

    if (consumeLintMeta(line, state, signatures)) {
      continue;
    }

    if (consumeSourceFile(line, state)) {
      continue;
    }

    const diagnostic = parsedDiagnostic(line, state);

    if (diagnostic !== null) {
      signatures.add(diagnostic);
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
