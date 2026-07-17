import { isRecord } from "../../lib/guards";
import type { IFailureParserState } from "./extract-failures.types";

// Build the ANSI-escape matcher from the ESC code point so the source carries no
// literal control char (a regex literal with \x1b trips no-control-regex).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** A CLOSED eslint-JSON block: opening marker, content (capture group 1), closing marker.
 *  The content is TEMPERED against another opening marker (`(?!…opening…)`) so an
 *  UNTERMINATED block can never pair with a LATER block's end marker and strip the
 *  intervening tsc/stylish/knip/app-marker output between them. Used both to extract
 *  signatures and to strip already-parsed blocks from the line-scanned text; an
 *  unterminated block matches nothing, so it stays in place and is parsed line-by-line
 *  (its partial JSON isn't an error row, so it never swallows the diagnostics that follow).
 *  A fresh RegExp is built per use so the shared `g`-flag lastIndex is never carried over. */
const ESLINT_JSON_BLOCK_SOURCE =
  "::tsforge-eslint-json \\S+::((?:(?!::tsforge-eslint-json \\S+::)[\\s\\S])*?)::tsforge-eslint-json-end::";

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

/** eslint's absolute `filePath` → repo-relative (strip the clone path + leading `/`).
 *  Collapse whitespace so it matches the model's editable-scope globs. */
function toRepoRelative(filePath: string, cwd: string): string {
  return filePath.split(cwd).join("").replace(/^\/+/u, "").trim();
}

/** The dedup key for a single eslint error: file + line + column + rule. Two eslint
 *  errors share a key iff they are the SAME diagnostic (same location AND rule) — column
 *  is included so two reports of the same rule on the same line at different columns stay
 *  DISTINCT. The message is deliberately excluded: the JSON and stylish formatters render
 *  the same error's text slightly differently (trailing period, truncation), so keying on
 *  message would fail to dedup identical errors. Built identically from the JSON payload
 *  and the stylish row so the two match exactly. */
function eslintKey(
  file: string,
  line: number | undefined,
  column: number | undefined,
  rule: string
): string {
  return `${file}:${line ?? ""}:${column ?? ""}:${rule}`;
}

/** Turn one eslint JSON result-file into structured failure signatures — the same
 *  `failure:<file>:<line>:<rule>:<message>` shape the stylish path produces, but from
 *  UNAMBIGUOUS structured data (exact file/line/ruleId/message per message). Only
 *  ERRORS (severity 2) count — warnings don't fail the gate. A rule-less message (a
 *  parsing error) is tagged `syntax`, matching the tsc-parser convention. Each emitted
 *  signature's location-key is also recorded in `keys` so the line loop can dedup the
 *  matching stylish row (and ONLY that row). */
function eslintResultSignatures(
  result: unknown,
  cwd: string,
  signatures: Set<string>,
  keys: Set<string>
): void {
  if (!isRecord(result) || typeof result.filePath !== "string") {
    return;
  }

  const file = toRepoRelative(result.filePath, cwd);
  const messages = result.messages;

  if (!Array.isArray(messages)) {
    return;
  }

  for (const message of messages) {
    if (!isRecord(message) || message.severity !== 2) {
      continue;
    }

    const rule = typeof message.ruleId === "string" ? message.ruleId : "syntax";
    // Collapse whitespace so a multi-line message yields the SAME signature as the
    // stylish path (which normalize()s to single spaces) — else the same error would
    // key differently by source and a re-parse could look "novel" in the differential.
    const text =
      typeof message.message === "string"
        ? message.message.replace(/\s+/gu, " ").trim()
        : "";
    const line = typeof message.line === "number" ? message.line : undefined;
    const column =
      typeof message.column === "number" ? message.column : undefined;

    signatures.add(structuredFailure(file, line, rule, text));
    keys.add(eslintKey(file, line, column, rule));
  }
}

/** Parse every `::tsforge-eslint-json <app>::` … `::tsforge-eslint-json-end::` block
 *  into structured eslint signatures (added to `signatures`), recording each error's
 *  location-key in `keys`. A green/empty `[]`, a wrong-shaped array (`[1,2,3]`), or a
 *  malformed message entry simply contributes NO keys — so it suppresses nothing. The
 *  line loop later drops a stylish row ONLY when its exact location-key is already in
 *  `keys` (the same error, from JSON), never an error the JSON didn't report. This is
 *  dedup, not per-app suppression: a JSON subset can no longer hide a stylish-only
 *  error, and a broken/absent block loses nothing. Only CLOSED blocks match here; an
 *  unterminated block contributes nothing and is left in the text for normal parsing. */
function parseEslintJsonBlocks(
  output: string,
  cwd: string,
  signatures: Set<string>,
  keys: Set<string>
): void {
  const blocks = output.matchAll(new RegExp(ESLINT_JSON_BLOCK_SOURCE, "gu"));

  for (const block of blocks) {
    const raw = (block[1] ?? "").replace(ANSI, "");
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");

    if (start < 0 || end <= start) {
      continue;
    }

    let results: unknown;

    try {
      results = JSON.parse(raw.slice(start, end + 1));
    } catch {
      continue;
    }

    if (!Array.isArray(results)) {
      continue;
    }

    for (const result of results) {
      eslintResultSignatures(result, cwd, signatures, keys);
    }
  }
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
  // A COMPLETE single-line row already has its ruleId (ANY id, incl. bare core rules
  // like `eqeqeq`) in eslint's padded right column: `… message  rule`. Such rows —
  // and rule-LESS ones we can't safely join — pass through untouched.
  const isCompleteRow = (s: string): boolean =>
    isErrorStart(s) && /\S {2,}[\w@/-]+\s*$/u.test(plain(s));
  // A multi-line TERMINATOR is the padded ruleId column carrying a PLUGIN-qualified id
  // (contains `/`, e.g. `module-boundaries/single-semantic-module`). Requiring the
  // slash keeps a prose continuation like `Do not use  console` from being mistaken
  // for a ruleId and terminating the join early.
  const isRuleIdTerminator = (s: string): boolean =>
    /\S {2,}@?[\w-]+\/[\w@/-]+\s*$/u.test(plain(s));

  // Any diagnostic row (error OR warning) — a following one must never be fused into
  // the current message, even though a warning row is also plugin-qualified.
  const isDiagnosticRow = (s: string): boolean =>
    /^\s*\d+:\d+\s+(?:error|warning)\s/u.test(plain(s));

  // A BOUNDARY the join must NOT cross or consume — ANY other failure/structural line
  // in the interleaved gate output: an eslint diagnostic row (error/warning), a tsc
  // `error TS…`, a bun `(fail)` row, a knip `Unused files` header, a `[lint:meta]`
  // block, an `::tsforge-app::` marker, a `$` echo, or a source-file HEADER. The
  // header must be a BARE path (the whole trimmed line is a single path token) — NOT
  // any line that merely ends in `.ts`, else a prose body like `Move types into
  // bookmark.types.ts` would abort the join. This keeps the join from swallowing an
  // interleaved OTHER failure (which the outer parser would then never see) and from
  // fusing a following diagnostic into the current message.
  const isBoundary = (s: string): boolean => {
    const p = plain(s).trim();

    return (
      isDiagnosticRow(s) ||
      /\berror TS\d+/u.test(p) ||
      p.startsWith("(fail)") ||
      /^Unused files \(\d+\)$/u.test(p) ||
      p.startsWith("[lint:meta]") ||
      p.startsWith("$") ||
      /^::tsforge-app .+::$/u.test(p) ||
      /^\S+\.[cm]?[jt]sx?:?$/u.test(p)
    );
  };

  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const start = lines[i] ?? "";

    // Only a multi-line OPEN — an error row that is NOT already complete — can start a
    // join. Everything else (non-errors, complete single-line rows, rule-less rows)
    // passes through.
    if (!isErrorStart(start) || isCompleteRow(start)) {
      out.push(start);
      continue;
    }

    // Scan forward for a plugin-qualified terminator, STOPPING at (never crossing) a
    // boundary. No line cap: the boundary IS the stop condition, so nothing is
    // silently truncated by an arbitrary length limit.
    let j = i + 1;

    while (
      j < lines.length &&
      !isRuleIdTerminator(lines[j] ?? "") &&
      !isBoundary(lines[j] ?? "")
    ) {
      j += 1;
    }

    // Collapse ONLY when the stop line is a genuine terminator that is NOT itself a
    // boundary (a following error row is both, and must stay separate). Otherwise emit
    // the start row UNCHANGED — a parse error / unterminated block never absorbs.
    const terminator =
      j < lines.length &&
      isRuleIdTerminator(lines[j] ?? "") &&
      !isBoundary(lines[j] ?? "");

    if (terminator) {
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

/** A source-file header printed before bun/eslint/lint-meta diagnostics. A real header
 *  is a BARE path (the whole line is one path token) — require that, so a prose line
 *  that merely ENDS in `.ts` (e.g. a rule message "Move types into bookmark.types.ts")
 *  is never mistaken for a header and promoted to `currentFile`. */
function sourceFileFromLine(line: string, app: string): string | null {
  const withoutColon = line.endsWith(":") ? line.slice(0, -1) : line;

  if (!/^\S+\.[cm]?[jt]sx?$/u.test(withoutColon.trim())) {
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

/** A parsed failure line: its stable signature plus, for eslint rows only, the dedup key
 *  used to drop a stylish row that duplicates a JSON-reported error. `dedupKey` is null
 *  for tsc/bun/fallback rows (they never collide with an eslint JSON key). */
interface IParsedDiagnostic {
  signature: string;
  dedupKey: string | null;
}

function parsedDiagnostic(
  line: string,
  state: IFailureParserState
): IParsedDiagnostic | null {
  const typeError = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.+)$/u.exec(line);

  if (typeError !== null) {
    const file = qualify(
      state.app,
      (typeError[1] ?? "").replace(/^\.\//u, "").replace(/^\//u, "")
    );

    return {
      signature: structuredFailure(
        file,
        Number(typeError[2] ?? "0"),
        typeError[4] ?? "tsc",
        typeError[5] ?? line
      ),
      dedupKey: null,
    };
  }

  // An eslint PARSING error carries no ruleId — the row is `L:C error Parsing
  // error: <detail>`. normalize() has already collapsed the multi-space gap that
  // separates an eslint message from its trailing ruleId, so the generic row
  // regex below would grab the message's last word (`… ';' expected` → rule
  // `expected`) and mint a phantom rule. Capture these as `syntax` (matching the
  // tsc-parser convention) so no message word ever masquerades as a rule id.
  const eslintParseError = /^(\d+):(\d+) error (Parsing error:.*)$/u.exec(line);

  if (eslintParseError !== null && state.currentFile !== "") {
    const eslintLine = Number(eslintParseError[1] ?? "0");
    const column = Number(eslintParseError[2] ?? "0");

    return {
      signature: structuredFailure(
        state.currentFile,
        eslintLine,
        "syntax",
        eslintParseError[3] ?? line
      ),
      dedupKey: eslintKey(state.currentFile, eslintLine, column, "syntax"),
    };
  }

  const eslintError = /^(\d+):(\d+) error (.+?) ([\w@/-]+)$/u.exec(line);

  if (eslintError !== null && state.currentFile !== "") {
    const eslintLine = Number(eslintError[1] ?? "0");
    const column = Number(eslintError[2] ?? "0");
    const rule = eslintError[4] ?? "eslint";

    return {
      signature: structuredFailure(
        state.currentFile,
        eslintLine,
        rule,
        eslintError[3] ?? line
      ),
      dedupKey: eslintKey(state.currentFile, eslintLine, column, rule),
    };
  }

  if (line.startsWith("(fail)") && state.currentFile !== "") {
    return {
      signature: structuredFailure(
        state.currentFile,
        undefined,
        "bun-test",
        line
      ),
      dedupKey: null,
    };
  }

  return line.length > 0 && isErrorLine(line)
    ? { signature: line, dedupKey: null }
    : null;
}

/** Reduce a raw `[generate:api] FAILED: <reason>` reason to a STABLE class token, so
 *  the same infra failure class ("API down") yields the same signature regardless of
 *  the exact wording (ECONNREFUSED vs. timeout vs. a status line). A fingerprint that
 *  drifted with the reason text would defeat stuck-detection for one infra class. */
export function classifyOpenApiFailure(reason: string): string {
  const r = reason.toLowerCase();

  if (r.includes("econnrefused") || r.includes("connection refused")) {
    return "connection-refused";
  }

  if (
    r.includes("etimedout") ||
    r.includes("timeout") ||
    r.includes("timed out")
  ) {
    return "timeout";
  }

  if (
    r.includes("enotfound") ||
    r.includes("getaddrinfo") ||
    r.includes("dns")
  ) {
    return "dns";
  }

  const status = /\b([1-5]\d\d)\b/u.exec(reason);

  if (status !== null) {
    return `http-${status[1] ?? ""}`;
  }

  return "unreachable";
}

/** The BoringStack UI's `generate:api` step fetches the OpenAPI spec from the
 *  running API and prints `[generate:api] FAILED: <reason>` when it can't. That is
 *  an INFRA/precondition failure (the API isn't serving /swagger/json), not a lint
 *  or type diagnostic the model can edit toward — left unrecognized it collapses
 *  into an opaque `gate-nonzero` the model oscillated on for 5 cycles then regressed.
 *  Surface it as one clear, actionable signature (rule `openapi-unreachable`) keyed by
 *  a STABLE failure class (NO file component — signatureToError maps it to a file-less
 *  "own" error; the full actionable guidance is built there). */
function generateApiFailure(line: string): string | null {
  const failed = /^\[generate:api\] FAILED: (.+)$/u.exec(line);

  if (failed === null) {
    return null;
  }

  return `openapi-unreachable:${classifyOpenApiFailure(failed[1] ?? "fetch failed")}`;
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

  // Prefer STRUCTURED eslint output: parse each `::tsforge-eslint-json <app>::` block
  // into exact signatures and record each error's location-key. Then STRIP the closed
  // blocks from the line-scanned text so a JSON message like `error TS…` can't be
  // mis-parsed as a diagnostic — an unterminated block is left in place and parsed
  // normally, never swallowing later lines. A stylish row that duplicates a JSON error
  // (same file/line/rule key) is dropped in the loop; a stylish-only error is kept.
  const jsonKeys = new Set<string>();

  parseEslintJsonBlocks(output, cwd, signatures, jsonKeys);

  const scanned = output.replace(
    new RegExp(ESLINT_JSON_BLOCK_SOURCE, "gu"),
    ""
  );

  for (const rawLine of joinMultilineEslintRows(scanned).split("\n")) {
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

    const apiFailure = generateApiFailure(line);

    if (apiFailure !== null) {
      signatures.add(apiFailure);
      continue;
    }

    const diagnostic = parsedDiagnostic(line, state);

    if (diagnostic === null) {
      continue;
    }

    // Drop a stylish eslint row only when the JSON already reported the SAME error
    // (identical file/line/column/rule) — dedup, not per-app suppression, so a
    // stylish-only error the JSON never emitted is always kept. Non-eslint rows
    // (tsc/bun/fallback) carry no dedupKey and are never dropped.
    if (diagnostic.dedupKey !== null && jsonKeys.has(diagnostic.dedupKey)) {
      continue;
    }

    signatures.add(diagnostic.signature);
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
