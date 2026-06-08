import { basename } from "node:path";
import { isRecord } from "../../lib/guards";

/**
 * OUTPUT CONDITIONING — the single pipeline that maximizes signal-per-token for
 * whatever the model runs through the `run` (arbitrary shell) tool. At a slow local
 * model, every byte of a command's output is re-read each subsequent turn, so noisy
 * binaries (eslint's per-file JSON, vite's chunk table, a `find` listing) waste real
 * time and context. ONE chokepoint conditions it, governed by one invariant:
 *
 *   DROP CEREMONY, PRESERVE SIGNAL, GO VERBOSE ON FAILURE.
 *
 *   - ceremony (safe to cut): progress/spinners, success banners, repeated path
 *     prefixes, all-clear blobs, repeated identical lines, asset/chunk tables.
 *   - signal (never cut): errors, warnings, the actual answer, counts, the specific
 *     paths/lines the model must act on.
 *   - exit-code: on a non-zero exit, condense MINIMALLY — a failure is exactly when
 *     the detail matters.
 *
 * The architecture is layered, most-leverage first:
 *   L1 generic SHAPE condensers (tool-agnostic): one covers a whole class of
 *      binaries — path-list (find/ls/tree), repeated-line collapse, big-JSON.
 *   L2 per-tool condensers (precise, high-frequency): eslint, vite.
 *   L3 universal truncation backstop: a SIGNAL-PRESERVING head+tail cap (never a
 *      blind tail-slice that could cut off the summary).
 * Each condenser returns null when the output isn't its shape, so anything
 * unrecognized passes through to the backstop untouched.
 */

/** Context for condensing one command's output. */
export interface ICondenseCtx {
  command: string;
  output: string;
  exitCode: number;
}

/** The conditioned text + which condenser fired (for instrumentation). */
export interface ICondenseResult {
  text: string;
  /** Condenser name, `"<name>+truncate"`, `"truncate"`, or null if untouched. */
  via: string | null;
  originalChars: number;
  finalChars: number;
}

interface IOutputCondenser {
  name: string;
  condense(ctx: ICondenseCtx): string | null;
}

// ─── L2: eslint --format json ────────────────────────────────────────────────

/** Max DISTINCT (file × rule) groups to show when condensing ESLint JSON. */
const MAX_ESLINT_GROUPS = 25;
/** Max line numbers listed per group before eliding (the same rule on many lines). */
const MAX_GROUP_LINES = 15;

/** One (file × rule) group: the SAME rule firing on N lines collapses to one line. */
interface IEslintGroup {
  file: string;
  rule: string;
  message: string;
  severe: boolean;
  lines: number[];
}

interface IEslintTally {
  errors: number;
  warnings: number;
  /** Keyed by `${file}|${rule}` so a repeated rule aggregates instead of repeating. */
  groups: Map<string, IEslintGroup>;
}

/** Tally one ESLint message into `acc`, grouping by file+rule. */
function tallyEslintMessage(
  filePath: string,
  message: unknown,
  acc: IEslintTally
): void {
  if (!isRecord(message)) {
    return;
  }

  const severe = message.severity === 2;

  acc.errors += severe ? 1 : 0;
  acc.warnings += severe ? 0 : 1;

  const file = basename(filePath);
  const rule = typeof message.ruleId === "string" ? message.ruleId : "?";
  const text = typeof message.message === "string" ? message.message : "";
  const line = typeof message.line === "number" ? message.line : 0;
  const key = `${file}|${rule}`;
  const existing = acc.groups.get(key);

  if (existing === undefined) {
    acc.groups.set(key, { file, rule, message: text, severe, lines: [line] });

    return;
  }

  existing.lines.push(line);
}

/** Render one group: a single occurrence stays `file:line msg (rule)`; many
 *  occurrences of the same rule collapse to `file msg (rule) — L1,L2,… (×N)`. */
function renderEslintGroup(g: IEslintGroup): string {
  const tag = g.severe ? "" : " [warn]";

  if (g.lines.length === 1) {
    return `  ${g.file}:${String(g.lines[0])} ${g.message} (${g.rule})${tag}`;
  }

  const shown = g.lines.slice(0, MAX_GROUP_LINES).map(String).join(",");
  const elided = g.lines.length > MAX_GROUP_LINES ? ",…" : "";

  return `  ${g.file} ${g.message} (${g.rule})${tag} — L${shown}${elided} (×${String(g.lines.length)})`;
}

/**
 * ESLint `--format json` dumps a full object PER FILE — for a 30-file app that's
 * ~30 verbose blobs of "errorCount: 0" noise. Collapse to a summary: "0 problems ✓",
 * or the problems GROUPED by file+rule (the same rule on 9 lines is one line, not
 * nine). Returns null if the output isn't ESLint JSON. The GATE parses raw JSON
 * elsewhere; this only affects what the MODEL reads from `run`.
 */
function condenseEslintJson(output: string): string | null {
  if (!output.includes('"filePath"') || !output.includes('"messages"')) {
    return null;
  }

  // Locate the JSON array even if eslint printed a deprecation warning or the
  // command was echoed before it. Slice from the first "[" to the last "]".
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");

  if (start < 0 || end <= start) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const acc: IEslintTally = { errors: 0, warnings: 0, groups: new Map() };

  for (const entry of parsed) {
    if (!isRecord(entry) || !Array.isArray(entry.messages)) {
      return null; // not the ESLint shape — don't risk mangling it
    }

    const filePath = typeof entry.filePath === "string" ? entry.filePath : "?";

    for (const message of entry.messages) {
      tallyEslintMessage(filePath, message, acc);
    }
  }

  if (acc.errors === 0 && acc.warnings === 0) {
    return `eslint: ${String(parsed.length)} files checked, 0 problems ✓`;
  }

  const groups = [...acc.groups.values()];
  const shownGroups = groups.slice(0, MAX_ESLINT_GROUPS);
  const body = shownGroups.map(renderEslintGroup).join("\n");
  const more =
    groups.length > shownGroups.length
      ? `\n  …and ${String(groups.length - shownGroups.length)} more rule/file group(s)`
      : "";

  return (
    `eslint: ${String(acc.errors)} error(s), ${String(acc.warnings)} warning(s) in ` +
    `${String(parsed.length)} files:\n${body}${more}`
  );
}

// ─── L2: vite build ──────────────────────────────────────────────────────────

/**
 * `vite build` prints a 20+ row chunk table (every `dist/assets/*.js` with raw +
 * gzip sizes) — noise the model never acts on. On a SUCCESSFUL build collapse to one
 * line. Returns null when it isn't a vite-build success (errors pass through — the
 * model must see those).
 */
function condenseViteBuild(output: string): string | null {
  const built = /built in ([\d.]+\s*m?s)/.exec(output);

  // Only condense a clean success: "✓ N modules transformed" + "built in …".
  if (built === null || !output.includes("modules transformed")) {
    return null;
  }

  if (/error|Could not resolve|failed|✗/i.test(output)) {
    return null;
  }

  const modules = /(\d+)\s+modules transformed/.exec(output);
  const chunks = (output.match(/dist\/assets\//g) ?? []).length;

  return (
    `vite build ✓ — ${modules?.[1] ?? "?"} modules, ${String(chunks)} chunks, ` +
    `built in ${built[1] ?? "?"} (chunk table elided)`
  );
}

// ─── L1: path-list (find / ls -R / tree / git ls-files) ──────────────────────

/** Min path-like lines before factoring a shared directory prefix. */
const MIN_PATH_LIST_LINES = 6;
/** Max relative entries listed after factoring, before eliding. */
const MAX_PATH_LIST = 60;

/** The longest common directory prefix (trimmed back to the last `/`) of `lines`. */
function commonDirPrefix(lines: readonly string[]): string {
  let prefix = lines[0] ?? "";

  for (const line of lines) {
    let i = 0;

    while (i < prefix.length && i < line.length && prefix[i] === line[i]) {
      i += 1;
    }

    prefix = prefix.slice(0, i);

    if (prefix.length === 0) {
      break;
    }
  }

  const lastSlash = prefix.lastIndexOf("/");

  return lastSlash >= 0 ? prefix.slice(0, lastSlash + 1) : "";
}

/**
 * A bare file listing (`find /abs/dir`, `ls -R`, `tree`) repeats the SAME long
 * directory prefix on every line. When most lines share a common directory prefix,
 * show it ONCE and list the rest relative. Returns null unless the output is clearly
 * such a listing (≥MIN lines, ≥90% contain a `/`, ≥8-char shared prefix) so arbitrary
 * output passes through untouched.
 */
function condensePathList(output: string): string | null {
  const lines = output
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  if (lines.length < MIN_PATH_LIST_LINES) {
    return null;
  }

  const pathy = lines.filter((l) => l.includes("/"));

  if (pathy.length < lines.length * 0.9) {
    return null; // mostly non-path lines — not a listing, leave it alone
  }

  const prefix = commonDirPrefix(lines);

  if (prefix.length < 8) {
    return null; // no meaningful shared prefix to factor out
  }

  const rels = lines.map((l) =>
    l.startsWith(prefix) ? l.slice(prefix.length) : l
  );
  const shown = rels
    .slice(0, MAX_PATH_LIST)
    .map((r) => `  ${r}`)
    .join("\n");
  const more =
    rels.length > MAX_PATH_LIST
      ? `\n  …and ${String(rels.length - MAX_PATH_LIST)} more`
      : "";

  return `${prefix} (${String(lines.length)} entries):\n${shown}${more}`;
}

// ─── L1: repeated-line collapse (dep installs, repeated warnings) ─────────────

/** Min run of identical consecutive lines before collapsing to `line  (×N)`. */
const MIN_REPEAT_RUN = 3;

/**
 * Collapse runs of ≥3 identical consecutive lines into one `line  (×N)`. Covers the
 * long tail of tools that spam the same line (dependency-resolution logs, a warning
 * emitted per file). Lossless for signal — the line is still shown, just once.
 * Returns null when nothing repeats enough to matter.
 */
function condenseRepeatedLines(output: string): string | null {
  const lines = output.split("\n");
  const out: string[] = [];
  let changed = false;
  let i = 0;

  while (i < lines.length) {
    let j = i + 1;

    while (j < lines.length && lines[j] === lines[i]) {
      j += 1;
    }

    const run = j - i;

    if (run >= MIN_REPEAT_RUN) {
      out.push(`${lines[i] ?? ""}  (×${String(run)})`);
      changed = true;
    } else {
      for (let k = i; k < j; k += 1) {
        out.push(lines[k] ?? "");
      }
    }

    i = j;
  }

  return changed ? out.join("\n") : null;
}

// ─── L1: big-JSON data dump ───────────────────────────────────────────────────

/** Only summarize a JSON ARRAY this large — a clear data dump, not a config file. */
const MIN_JSON_ARRAY_ITEMS = 50;
const MIN_JSON_CHARS = 4000;
const JSON_SAMPLE_CHARS = 400;

/**
 * A huge JSON ARRAY (≥50 items, ≥4k chars) is almost always a data listing where the
 * shape + first item is enough; summarize it with an escape hatch to re-fetch. VERY
 * conservative on purpose — config-file objects, small arrays, and any FAILURE pass
 * through (JSON content is often the signal, not ceremony). eslint JSON is caught by
 * its own condenser first, so this only sees other tools' `--json` dumps.
 */
function condenseBigJsonArray(ctx: ICondenseCtx): string | null {
  if (ctx.exitCode !== 0 || ctx.output.length < MIN_JSON_CHARS) {
    return null;
  }

  const start = ctx.output.indexOf("[");
  const end = ctx.output.lastIndexOf("]");

  if (start < 0 || end <= start) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(ctx.output.slice(start, end + 1));
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length < MIN_JSON_ARRAY_ITEMS) {
    return null;
  }

  const first: unknown = parsed[0];
  const keys = isRecord(first) ? Object.keys(first).join(", ") : "(non-object)";
  const sample = JSON.stringify(first).slice(0, JSON_SAMPLE_CHARS);

  return (
    `JSON array of ${String(parsed.length)} items (elided). keys: ${keys}\n` +
    `first: ${sample}…\n(re-run piping to a file + read specific entries if you need the full data)`
  );
}

// ─── pre-normalize: progress/spinner noise ────────────────────────────────────

/** A line that's only spinner glyphs / a progress bar (after trimming) — pure noise. */
const SPINNER_ONLY = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏━─]+$/;

/**
 * Universal pre-step applied to every command's output: collapse carriage-return
 * progress redraws (`\rProgress 50%\rProgress 100%` → keep the final state) and drop
 * spinner-only lines. No tool is harmed — the final state of each line is preserved —
 * and animated progress (npm/bun installs, downloads) stops bloating the context.
 */
function stripProgress(output: string): string {
  return output
    .split("\n")
    .map((line) => {
      const cr = line.lastIndexOf("\r");

      return cr >= 0 ? line.slice(cr + 1) : line;
    })
    .filter(
      (line) => !SPINNER_ONLY.test(line.trim()) || line.trim().length === 0
    )
    .join("\n");
}

// ─── L3: signal-preserving truncation backstop ────────────────────────────────

const HEAD_LINES = 40;
const TAIL_LINES = 20;
const SIGNAL_CAP = 40;
/** Lines worth keeping from the elided middle, even on an otherwise-quiet run. */
const SIGNAL_RE =
  /\b(error|errors|warning|warn|fail|failed|failure|cannot|undefined|exception|unexpected|not found)\b|✗|✖/i;

/**
 * The universal floor: when conditioned output still exceeds the cap, keep the HEAD
 * and TAIL (where the command and its summary live) plus any error/warning lines from
 * the middle — never a blind tail-slice that could cut off the very summary the model
 * needs. This is what catches the infinite long tail of binaries we have no specific
 * condenser for.
 */
function truncate(output: string, maxChars: number): string {
  if (output.length <= maxChars) {
    return output;
  }

  const lines = output.split("\n");

  if (lines.length <= HEAD_LINES + TAIL_LINES) {
    // Few but very long lines — slice by char, head-weighted, keep the tail.
    const headChars = Math.floor(maxChars * 0.7);
    const tailChars = Math.max(0, maxChars - headChars - 40);

    return `${output.slice(0, headChars)}\n… (${String(output.length - maxChars)} chars elided) …\n${output.slice(-tailChars)}`;
  }

  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(lines.length - TAIL_LINES);
  const middle = lines.slice(HEAD_LINES, lines.length - TAIL_LINES);
  const signal = middle.filter((l) => SIGNAL_RE.test(l)).slice(0, SIGNAL_CAP);
  const kept =
    signal.length > 0
      ? `, ${String(signal.length)} error/warn line(s) kept`
      : "";
  const parts = [
    ...head,
    `… ${String(middle.length - signal.length)} lines elided${kept} …`,
    ...signal,
    ...tail,
  ];
  const text = parts.join("\n");

  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n… (truncated)`
    : text;
}

// ─── the pipeline ──────────────────────────────────────────────────────────────

// Order: most-specific first (per-tool), then generic shapes. First non-null wins.
const CONDENSERS: readonly IOutputCondenser[] = [
  { name: "eslint", condense: (c) => condenseEslintJson(c.output) },
  { name: "vite", condense: (c) => condenseViteBuild(c.output) },
  { name: "path-list", condense: (c) => condensePathList(c.output) },
  { name: "repeated-lines", condense: (c) => condenseRepeatedLines(c.output) },
  { name: "json", condense: condenseBigJsonArray },
];

/**
 * Condition one command's output for the model: strip progress noise, run the
 * registry (first matching condenser wins), then apply the signal-preserving
 * truncation backstop. Returns the text plus which condenser fired and the
 * before/after sizes (so the loop can SHOW the saving and we can spot over-condensing).
 */
export function condenseToolOutput(
  ctx: ICondenseCtx,
  maxChars: number
): ICondenseResult {
  const originalChars = ctx.output.length;
  const normalized = stripProgress(ctx.output);
  const nctx: ICondenseCtx = { ...ctx, output: normalized };

  let text = normalized;
  let via: string | null = normalized === ctx.output ? null : "progress";

  for (const condenser of CONDENSERS) {
    const result = condenser.condense(nctx);

    if (result !== null) {
      text = result;
      via = condenser.name;
      break;
    }
  }

  if (text.length > maxChars) {
    text = truncate(text, maxChars);
    via = via === null ? "truncate" : `${via}+truncate`;
  }

  return { text, via, originalChars, finalChars: text.length };
}
