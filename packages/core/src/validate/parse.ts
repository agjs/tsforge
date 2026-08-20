import type { IErrorItem, ErrorParserFn } from "./validate.types";
import { isArray, isRecord } from "../lib/guards";

/** ANSI SGR color codes. Built from `String.fromCharCode(27)` rather than a
 *  literal ESC so the pattern doesn't trip `no-control-regex` (same technique as
 *  render/frame/ansi-plain.ts). */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");

/**
 * Normalize raw tool output before any regex parsing. Two failure modes this
 * closes, both of which silently reduced a whole gate wall to one opaque blob:
 *  - COLOR: under CI / `FORCE_COLOR`, tsc/eslint/bun/vitest wrap output in ANSI
 *    SGR codes. A leading `ESC[..m` is not `\s`, so glyph-/`^`-anchored regexes
 *    (`× case`, the vitest header, `(fail)`) never matched and parsed to zero.
 *  - CRLF: parsers `split("\n")`, so CRLF output left a trailing `\r` on every
 *    line; `.` doesn't match `\r`, so every `(.+)$`-anchored regex (TSC, the bun
 *    `(fail)` line, vitest reasons) failed to anchor. Fold CR/CRLF to LF.
 * A blob fallback isn't just less useful — its constant `nonzero` key makes the
 * stuck-detector (sameErrorSet) read "no progress" while the model is fixing.
 */
export function normalizeGateOutput(output: string): string {
  return output.replace(ANSI_SGR, "").replace(/\r\n?/g, "\n");
}

const TSC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
/** File-less tsc diagnostics — config/project-level errors like TS18003
 *  ("No inputs were found"). They carry no `file(line,col):` prefix, so the
 *  main TSC regex drops them; in mixed output they'd vanish entirely (the
 *  generic fallback only covers a ZERO-parse result). */
const TSC_GLOBAL = /^error (TS\d+): (.+)$/;
const GENERIC_CAP = 500;

/** Bound raw output without hiding that more text exists. */
export function capWithNotice(text: string, cap: number): string {
  return text.length > cap
    ? `${text.slice(0, cap)}\n… (output truncated)`
    : text;
}

/** Parse `tsc` output into a structured error set (one item per diagnostic). */
export function parseTsc(rawOutput: string): IErrorItem[] {
  const output = normalizeGateOutput(rawOutput);
  const items: IErrorItem[] = [];

  for (const line of output.split("\n")) {
    const m = TSC.exec(line);

    if (!m) {
      const g = TSC_GLOBAL.exec(line);

      if (g?.[1] !== undefined && g[2] !== undefined) {
        items.push({
          key: `tsc:${g[1]}`,
          rule: g[1],
          message: g[2].trim(),
        });
      }

      continue;
    }

    const [, file, lineStr, , rule, message] = m;

    if (
      file === undefined ||
      lineStr === undefined ||
      rule === undefined ||
      message === undefined
    ) {
      continue;
    }

    items.push({
      key: `${file}:${lineStr}:${rule}`,
      file,
      line: Number(lineStr),
      rule,
      message: message.trim(),
    });
  }

  return items;
}

/** Fallback when we have no tool-specific parser: the whole output is one error. */
export function genericErrors(output: string): IErrorItem[] {
  const text = normalizeGateOutput(output).trim();

  return text.length > 0
    ? [{ key: "raw", message: capWithNotice(text, GENERIC_CAP) }]
    : [];
}

/** A line is eslint's `--format json` blob when it begins `[{` and carries the
 *  array's tell-tale keys. The single source of truth shared by the parser
 *  (which extracts it) and the live-stream filter (which hides it). */
export function isEslintJsonLine(line: string): boolean {
  const t = line.trimStart();

  return (
    t.startsWith("[{") && t.includes('"filePath"') && t.includes('"messages"')
  );
}

/** Parse `s` as a JSON array, or null if it isn't one (no throw). */
function tryParseArray(s: string): unknown[] | null {
  try {
    const data: unknown = JSON.parse(s);

    return isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Parse `eslint --format json`. Errors (severity 2) only; warnings ignored.
 * Carries the `ruleId` — including custom plugin rules like
 * `@boring-stack/structured-logging` — so the repair loop sees exactly which
 * rule failed. Narrowed with guards (no type assertions).
 *
 * The WEB gate chains eslint inside `bun run build && tsc && eslint … && …`, so
 * the captured output is the vite build text WITH eslint's single JSON line
 * embedded — `JSON.parse` of the whole thing throws and every web lint error
 * used to dump as one raw blob (the gate's "pile of garbage"). So: parse the
 * whole output when it's pure JSON (the core gate), else scan for the standalone
 * JSON-array line(s) and union them — the chain can run eslint twice (syntactic
 * + type-aware), each emitting its own array.
 */
export function parseEslintJson(rawOutput: string): IErrorItem[] {
  const output = normalizeGateOutput(rawOutput);
  const whole = tryParseArray(output);

  if (whole !== null) {
    return whole.flatMap(eslintFileItems);
  }

  const items: IErrorItem[] = [];

  for (const line of output.split("\n")) {
    if (!line.trimStart().startsWith("[")) {
      continue;
    }

    const arr = tryParseArray(line.trim());

    if (arr !== null) {
      items.push(...arr.flatMap(eslintFileItems));
    }
  }

  return items;
}

/**
 * Human-readable one-line summaries of EVERY eslint message (warnings included),
 * for the fallback path. `parseEslintJson` keeps only errors (severity 2), so a
 * gate that fails purely on WARNINGS (`--max-warnings 0`, exit 1) parsed to zero
 * items AND then had its only description — the JSON line — stripped by
 * `fallbackMessage`, leaving the loop a contentless "command exited non-zero".
 * This recovers the warning text so the model can actually see what to fix.
 */
export function eslintMessageSummary(rawOutput: string): string[] {
  const output = normalizeGateOutput(rawOutput);
  const lines: string[] = [];

  for (const line of output.split("\n")) {
    if (!isEslintJsonLine(line)) {
      continue;
    }

    const arr = tryParseArray(line.trim());

    if (arr === null) {
      continue;
    }

    for (const file of arr) {
      collectEslintMessages(file, lines);
    }
  }

  return lines;
}

/** Append `file:line:col sev rule: message` for each message in one eslint file
 *  entry (both warnings and errors). */
function collectEslintMessages(file: unknown, out: string[]): void {
  if (!isRecord(file) || !isArray(file.messages)) {
    return;
  }

  const filePath = typeof file.filePath === "string" ? file.filePath : "?";

  for (const m of file.messages) {
    if (!isRecord(m)) {
      continue;
    }

    const lineNo = typeof m.line === "number" ? m.line : 0;
    const col = typeof m.column === "number" ? m.column : 0;
    const rule = typeof m.ruleId === "string" ? m.ruleId : "syntax";
    const sev = m.severity === 1 ? "warning" : "error";
    const message = typeof m.message === "string" ? m.message : "";

    out.push(
      `${filePath}:${String(lineNo)}:${String(col)} ${sev} ${rule}: ${message}`
    );
  }
}

/** Error items from one eslint JSON file entry (severity-2 messages only). */
function eslintFileItems(file: unknown): IErrorItem[] {
  if (!isRecord(file)) {
    return [];
  }

  const filePath = typeof file.filePath === "string" ? file.filePath : "";
  const messages = file.messages;

  if (!isArray(messages)) {
    return [];
  }

  const items: IErrorItem[] = [];

  for (const m of messages) {
    if (!isRecord(m) || m.severity !== 2) {
      continue;
    }

    const rule = typeof m.ruleId === "string" ? m.ruleId : "syntax";
    const lineNo = typeof m.line === "number" ? m.line : undefined;
    const message = typeof m.message === "string" ? m.message : "";

    items.push({
      key: `${filePath}:${lineNo ?? 0}:${rule}`,
      file: filePath,
      line: lineNo,
      rule,
      message: message.trim(),
    });
  }

  return items;
}

/**
 * For chained gates like `tsc -p … && eslint --format json … && bun test`,
 * `&&` short-circuits: when tsc fails the output is tsc's TEXT (eslint never
 * ran), and when it passes the output is eslint's JSON. A single tool-specific
 * parser is wrong for both phases — pick eslint-json and tsc-text output parses
 * to nothing (so the whole wall dumps as one blob); pick tsc and eslint's JSON
 * is missed. Run BOTH and union: their formats don't overlap (tsc-text vs JSON),
 * and only one is ever present at a time, so this is lossless either way.
 */
/**
 * Structured failures from bun test / vitest / jest output — failures only.
 * Used by brownfield gates so `bun test` is not a 500-char opaque blob.
 */
export function parseTestFailures(rawOutput: string): IErrorItem[] {
  const output = normalizeGateOutput(rawOutput);
  const items: IErrorItem[] = [];
  let bunFileCtx = "";
  // Vitest's DEFAULT reporter file context (`❯ file (N tests | M failed)`) —
  // tracked separately from the bun `file:` context so a stray `×` glyph in
  // arbitrary output can't parse as a failure without a preceding file line.
  const vitest: IVitestCtx = { file: "", failedCount: 0, namedFails: 0 };

  for (const line of output.split("\n")) {
    const bunFile = /^\s*(.+?\.(?:test|spec)\.[cm]?[jt]sx?):\s*$/u.exec(line);

    if (bunFile?.[1] !== undefined) {
      bunFileCtx = bunFile[1];
      continue;
    }

    if (parseBunFailLine(line, bunFileCtx, items)) {
      continue;
    }

    if (parseVitestLine(line, vitest, items)) {
      continue;
    }

    parseVitestVerboseFail(line, items);
  }

  flushUnnamedVitestFails(items, vitest);

  return items;
}

interface IVitestCtx {
  file: string;
  failedCount: number;
  namedFails: number;
}

/** A bun `(fail) title` row, keyed under the current `file:` context. */
function parseBunFailLine(
  line: string,
  file: string,
  items: IErrorItem[]
): boolean {
  const fail = /^\s*\(fail\)\s+(.+)$/u.exec(line);

  if (fail?.[1] === undefined) {
    return false;
  }

  const title = fail[1].trim();
  const key = file.length > 0 ? `${file}:${title}` : title;

  items.push({
    key,
    ...(file.length > 0 ? { file } : {}),
    rule: "bun-test",
    message: title,
  });

  return true;
}

/** Vitest default reporter: a `❯ file (N tests | M failed)` header opens a file
 *  context (a no-`failed` header closes it — all its tests passed); an `×` case
 *  line inside a context is one failure. */
function parseVitestLine(
  line: string,
  ctx: IVitestCtx,
  items: IErrorItem[]
): boolean {
  const header =
    /^\s*[❯✗✖]?\s*(.+?\.(?:test|spec)\.[cm]?[jt]sx?)\s+\((\d+) tests?(?:\s*\|\s*(\d+) failed)?\)/u.exec(
      line
    );

  if (header?.[1] !== undefined) {
    flushUnnamedVitestFails(items, ctx);
    ctx.file = header[1];
    ctx.failedCount = Number(header[3] ?? "0");
    ctx.namedFails = 0;

    return true;
  }

  const failCase = /^\s*[×✕]\s+(.+)$/u.exec(line);

  if (failCase?.[1] !== undefined && ctx.file.length > 0) {
    const title = failCase[1].trim();

    items.push({
      key: `${ctx.file}:${title}`,
      file: ctx.file,
      rule: "vitest",
      message: title,
    });
    ctx.namedFails += 1;

    return true;
  }

  return false;
}

/** The jest/CI-reporter shape: `FAIL src/x.test.ts <reason>`. */
function parseVitestVerboseFail(line: string, items: IErrorItem[]): void {
  const vitestFail =
    /^\s*FAIL\s+(.+?\.(?:test|spec)\.[cm]?[jt]sx?)\s*(.*)$/u.exec(line);

  if (vitestFail?.[1] === undefined) {
    return;
  }

  const f = vitestFail[1];
  const rest = (vitestFail[2] ?? "").trim();
  const message = rest.length > 0 ? rest : "test failed";

  items.push({ key: `${f}:${message}`, file: f, rule: "vitest", message });
}

/** When a vitest `❯ file (N tests | M failed)` header reported failures but no
 *  `×` lines followed (a reporter variant, or the titles were filtered), emit
 *  one summary item — a failed file must never parse to ZERO errors. */
function flushUnnamedVitestFails(items: IErrorItem[], ctx: IVitestCtx): void {
  if (ctx.file.length > 0 && ctx.failedCount > 0 && ctx.namedFails === 0) {
    items.push({
      key: `${ctx.file}:failed`,
      file: ctx.file,
      rule: "vitest",
      message: `${String(ctx.failedCount)} test(s) failed`,
    });
  }
}

export function combinedParser(output: string): IErrorItem[] {
  const merged = [
    ...parseTsc(output),
    ...parseEslintJson(output),
    ...parseTestFailures(output),
  ];
  const seen = new Set<string>();

  return merged.filter((e) => {
    if (seen.has(e.key)) {
      return false;
    }

    seen.add(e.key);

    return true;
  });
}

/** A whole-word match where `-` counts as part of the word, so `tsc` does NOT
 *  match inside `tsc-alias`/`tsc-watch` (a plain `\btsc\b` does, because `-` is a
 *  word boundary — that mis-selected the tsc parser for a gate whose real
 *  compiler never ran). */
function hasWord(command: string, word: string): boolean {
  return new RegExp(`(?<![\\w-])${word}(?![\\w-])`, "u").test(command);
}

/** Pick a parser from the command. Add tools here as we support them. */
export function parserFor(command: string): ErrorParserFn {
  const hasTsc = hasWord(command, "tsc");
  const hasEslint = hasWord(command, "eslint");
  const hasTest =
    /(?<![\w-])bun\s+test(?![\w-])/u.test(command) ||
    hasWord(command, "vitest") ||
    hasWord(command, "jest");

  // A chained tsc+eslint(+tests) gate needs the combined parser (see above).
  if (hasTsc && hasEslint) {
    return combinedParser;
  }

  if (hasEslint) {
    return parseEslintJson;
  }

  if (hasTsc && hasTest) {
    return (output) => [...parseTsc(output), ...parseTestFailures(output)];
  }

  if (hasTsc) {
    return parseTsc;
  }

  if (hasTest) {
    return (output) => {
      const items = parseTestFailures(output);

      return items.length > 0 ? items : genericErrors(output);
    };
  }

  return genericErrors;
}
