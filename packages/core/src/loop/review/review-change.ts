import { isAbsolute, join } from "node:path";
import { runArgvCommand } from "../../lib/fs";
import { isRecord, isArray } from "../../lib/guards";
import { extractJson } from "../../lib/json";
import type { IProvider } from "../../inference";
import type { TsService } from "../../lsp";
import { buildTsService } from "../turn";
import { LENSES, lensRubric } from "./lenses";
import { callerSignal } from "./signals";
import type {
  IRepoFinding,
  IVerifiedFinding,
  IReviewReport,
  Severity,
} from "./review.types";

const MAX_FILES = 25;
const DIFF_CHARS = 6000;
const WINDOW = 8;
const LENS_IDS = new Set<string>(LENSES.map((l) => l.id));

export interface IReviewOptions {
  /** Explicit base ref; default = auto-detected (merge-base with the default branch). */
  base?: string;
  /** Review only staged changes (pre-commit). */
  staged?: boolean;
  /** Run the adversarial-verify pass (default true). Off = raw findings pass
   *  through unverified — for A/B measuring verify's effect on precision. */
  verify?: boolean;
  /** Rules the automated gate is CURRENTLY failing on (a gate-aware run). The find
   *  pass is told NOT to duplicate what these cover — the gate loop fixes them —
   *  so it spends its attention on the behaviour of the code the gate accepts. */
  gateFailingRules?: readonly string[];
  /** Progress callback (one line per step). */
  log?: (message: string) => void;
}

/** Run `git` with an explicit argv (no shell); return trimmed stdout, "" on error. */
async function gitText(cwd: string, argv: string[]): Promise<string> {
  const res = await runArgvCommand(cwd, ["git", ...argv]);

  return res.exitCode === 0 ? res.stdout.trim() : "";
}

/** The ref to diff the working tree against: explicit override, else the
 *  merge-base with the default branch, else HEAD (already on the default branch). */
async function detectBase(cwd: string, override?: string): Promise<string> {
  if (override !== undefined && override.length > 0) {
    return override;
  }

  const branch = await gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);

  for (const candidate of ["main", "master"]) {
    const exists = await gitText(cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      candidate,
    ]);

    if (exists.length === 0 || branch === candidate) {
      continue;
    }

    const mergeBase = await gitText(cwd, ["merge-base", "HEAD", candidate]);

    if (mergeBase.length > 0) {
      return mergeBase;
    }
  }

  return "HEAD";
}

const SOURCE_RE = /\.(ts|tsx|js|jsx|mts|cts)$/;

function splitFiles(out: string): string[] {
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => SOURCE_RE.test(f));
}

/** The set of changed source files to review, with coverage bookkeeping so a
 *  capped run never reports as if it were complete. */
interface IChangeSet {
  /** Files to review (deduped, capped at MAX_FILES). */
  files: string[];
  /** Total candidate files BEFORE the cap (files.length when nothing was dropped). */
  totalCandidates: number;
  /** Which of `files` are untracked (need a synthesized added-file diff). */
  untracked: ReadonlySet<string>;
}

/** Changed source files in the working tree vs `base` (or staged-only), INCLUDING
 *  brand-new untracked files. `git diff` against a ref only sees TRACKED files, so
 *  without unioning `ls-files --others` a newly created (never `git add`ed) source
 *  file is silently skipped — the review would report "nothing to review" for a
 *  whole new module. Staged mode reviews the index only, where a new file is
 *  already tracked, so untracked files are excluded there. */
async function collectChangedFiles(
  cwd: string,
  base: string,
  staged: boolean
): Promise<IChangeSet> {
  // --diff-filter=d drops deleted files — no point reviewing a file that's gone.
  const trackedArgv = staged
    ? ["diff", "--name-only", "--diff-filter=d", "--staged"]
    : ["diff", "--name-only", "--diff-filter=d", base];
  const tracked = splitFiles(await gitText(cwd, trackedArgv));

  const untrackedList = staged
    ? []
    : splitFiles(
        await gitText(cwd, ["ls-files", "--others", "--exclude-standard"])
      );
  const untracked = new Set(untrackedList);

  const all: string[] = [];

  for (const file of [...tracked, ...untrackedList]) {
    if (!all.includes(file)) {
      all.push(file);
    }
  }

  return {
    files: all.slice(0, MAX_FILES),
    totalCandidates: all.length,
    untracked,
  };
}

/** A file's diff plus coverage flags. `ranges` is the new-side line spans the
 *  change actually touched (parsed from the FULL diff, before truncation) — used
 *  to keep findings on changed lines rather than pre-existing code. */
interface IFileDiff {
  diff: string;
  truncated: boolean;
  ranges: readonly (readonly [number, number])[];
}

/** Synthesize an all-added unified diff for an untracked file (it has no `base`
 *  side to diff against), so the find pass sees it as a fully new addition and the
 *  hunk parser marks every line as changed. */
async function syntheticAddedDiff(cwd: string, file: string): Promise<string> {
  const abs = isAbsolute(file) ? file : join(cwd, file);
  const text = await Bun.file(abs)
    .text()
    .catch(() => "");

  if (text.length === 0) {
    return "";
  }

  const lines = text.split("\n");

  // A trailing newline leaves a final empty element — drop it so the @@ count
  // matches the real line count.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const body = lines.map((l) => `+${l}`).join("\n");

  return `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${String(lines.length)} @@\n${body}`;
}

/** New-side line ranges a unified diff touches, from its `@@ -a,b +c,d @@` heads.
 *  A finding outside every range sits on code the change didn't touch. */
function changedLineRanges(diff: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu;

  for (let m = re.exec(diff); m !== null; m = re.exec(diff)) {
    const start = Number.parseInt(m[1] ?? "", 10);
    const count = m[2] === undefined ? 1 : Number.parseInt(m[2], 10);

    if (
      Number.isFinite(start) &&
      start > 0 &&
      Number.isFinite(count) &&
      count > 0
    ) {
      ranges.push([start, start + count - 1]);
    }
  }

  return ranges;
}

function lineInRanges(
  line: number,
  ranges: readonly (readonly [number, number])[]
): boolean {
  return ranges.some(([from, to]) => line >= from && line <= to);
}

async function fileDiff(
  cwd: string,
  base: string,
  file: string,
  staged: boolean,
  untracked: boolean
): Promise<IFileDiff> {
  const raw = untracked
    ? await syntheticAddedDiff(cwd, file)
    : await gitText(
        cwd,
        staged ? ["diff", "--staged", "--", file] : ["diff", base, "--", file]
      );

  return {
    diff: raw.slice(0, DIFF_CHARS),
    truncated: raw.length > DIFF_CHARS,
    ranges: changedLineRanges(raw),
  };
}

const FIND_SYSTEM_BASE = [
  "You are a senior engineer reviewing a code change for FUNCTIONAL problems: logic errors, regressions, missed edge cases, and broken business rules.",
  "A separate automated gate already covers types, structure, and style — do NOT report those. Only functional/behavioural issues.",
  "Review the change THROUGH these lenses:",
  LENSES.map(lensRubric).join("\n\n"),
  "Rules: report ONLY concrete problems you can tie to a specific changed line. If the change looks correct, return an empty list. Never speculate — prefer silence over a guess.",
  'Respond with ONLY JSON: {"findings":[{"line":<number>,"severity":"error|warning|info","lens":"<lens id>","claim":"<what is wrong>","reason":"<why>"}]}.',
].join("\n\n");

/** The find-pass system prompt, optionally with a gate-aware clause: when the
 *  caller knows which rules the gate is ALREADY failing, tell the model not to
 *  duplicate them — its attention goes to the behaviour of the green code. */
function buildFindSystem(gateFailingRules: readonly string[]): string {
  if (gateFailingRules.length === 0) {
    return FIND_SYSTEM_BASE;
  }

  return `${FIND_SYSTEM_BASE}\n\nThe automated gate is ALREADY failing on these rule(s): ${gateFailingRules.join(", ")}. Do NOT report problems those rules cover — the gate loop will fix them. Focus on the BEHAVIOUR of the code the gate already accepts.`;
}

/** One find pass over a single changed file's diff (per-file decomposition keeps
 *  a small model in its reliable zone). */
async function findInFile(
  provider: IProvider,
  system: string,
  file: string,
  diff: string,
  signal: string
): Promise<IRepoFinding[]> {
  if (diff.length === 0) {
    return [];
  }

  const callers =
    signal.length > 0
      ? `\n\nCallers of this file's exports (type-exact — review these for regressions):\n${signal}`
      : "";

  const res = await provider.complete(
    [
      { role: "system", content: system },
      {
        role: "user",
        content: `File: ${file}\n\nDiff (base → working tree):\n${diff}${callers}`,
      },
    ],
    { temperature: 0 }
  );

  return parseFindings(res.content, file);
}

function toSeverity(value: unknown): Severity {
  if (value === "error" || value === "warning" || value === "info") {
    return value;
  }

  return "info";
}

/** A 1-based line, accepting a number OR a numeric string (models emit both). */
function toLine(value: unknown): number {
  if (typeof value === "number" && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);

    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }

  return 1;
}

function parseFindings(content: string, file: string): IRepoFinding[] {
  let data: unknown;

  try {
    data = JSON.parse(extractJson(content));
  } catch {
    return [];
  }

  const raw = isRecord(data) ? data.findings : undefined;

  if (!isArray(raw)) {
    return [];
  }

  const out: IRepoFinding[] = [];

  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }

    const { line, lens, claim, reason } = entry;

    if (typeof claim !== "string" || claim.length === 0) {
      continue;
    }

    out.push({
      file,
      line: toLine(line),
      severity: toSeverity(entry.severity),
      lens:
        typeof lens === "string" && LENS_IDS.has(lens) ? lens : "correctness",
      claim,
      reason: typeof reason === "string" ? reason : "",
    });
  }

  return out;
}

/** A numbered window of the real file around `line` (the evidence the verifier
 *  judges against — a finding that the actual code doesn't confirm is dropped). */
async function codeWindow(
  cwd: string,
  file: string,
  line: number
): Promise<string> {
  const abs = isAbsolute(file) ? file : join(cwd, file);
  const text = await Bun.file(abs)
    .text()
    .catch(() => "");

  if (text.length === 0) {
    return "";
  }

  const lines = text.split("\n");
  const from = Math.max(0, line - 1 - WINDOW);
  const to = Math.min(lines.length, line + WINDOW);

  return lines
    .slice(from, to)
    .map((l, i) => `${from + i + 1}: ${l}`)
    .join("\n");
}

const VERIFY_SYSTEM = [
  "You are verifying a code-review finding. Be skeptical: a finding survives ONLY if the actual code shown clearly confirms a real functional problem.",
  "Default to rejecting — if the evidence is ambiguous, not present, or the claim is speculative, mark it not real.",
  'Respond with ONLY JSON: {"real":true|false,"verdict":"<one short sentence>"}.',
].join("\n");

/** Adversarially re-check one finding against the real code. */
async function verifyFinding(
  provider: IProvider,
  cwd: string,
  finding: IRepoFinding
): Promise<IVerifiedFinding> {
  const window = await codeWindow(cwd, finding.file, finding.line);
  const drop = (verdict: string): IVerifiedFinding => ({
    ...finding,
    verified: false,
    verdict,
  });

  if (window.length === 0) {
    return drop("no code at the cited location");
  }

  const res = await provider.complete(
    [
      { role: "system", content: VERIFY_SYSTEM },
      {
        role: "user",
        content: `Finding [${finding.lens}] at ${finding.file}:${finding.line}\nClaim: ${finding.claim}\nReason: ${finding.reason}\n\nActual code:\n${window}\n\nIs this a real functional problem?`,
      },
    ],
    { temperature: 0 }
  );

  let data: unknown;

  try {
    data = JSON.parse(extractJson(res.content));
  } catch {
    return drop("unverifiable (unparseable verdict)");
  }

  const real = isRecord(data) && data.real === true;
  const verdict =
    isRecord(data) && typeof data.verdict === "string" ? data.verdict : "";

  return { ...finding, verified: real, verdict };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** findInFile, but a thrown error degrades to no findings (one bad file can't
 *  abort the whole review). */
async function safeFind(
  provider: IProvider,
  system: string,
  svc: TsService | null,
  cwd: string,
  file: string,
  diff: string,
  log: (m: string) => void
): Promise<IRepoFinding[]> {
  try {
    // callerSignal lives INSIDE the try so a LanguageService hiccup on one file
    // degrades that file's review, never aborting the whole run.
    const signal = callerSignal(svc, cwd, file);

    return await findInFile(provider, system, file, diff, signal);
  } catch (err) {
    log(`  ${file}: review failed — ${errText(err)}`);

    return [];
  }
}

/** verifyFinding, but a thrown error drops the finding (fail closed on error). */
async function safeVerify(
  provider: IProvider,
  cwd: string,
  finding: IRepoFinding,
  log: (m: string) => void
): Promise<IVerifiedFinding> {
  try {
    return await verifyFinding(provider, cwd, finding);
  } catch (err) {
    log(`  verify failed at ${finding.file}:${finding.line} — ${errText(err)}`);

    return { ...finding, verified: false, verdict: "verification error" };
  }
}

/**
 * Review the change you're on (working tree vs the auto-detected base, including
 * uncommitted edits). Per-file find pass guided by the senior-review lenses, then
 * an adversarial-verify pass that drops findings the real code doesn't confirm.
 */
export async function reviewChange(
  provider: IProvider,
  cwd: string,
  opts: IReviewOptions = {}
): Promise<IReviewReport> {
  const log = opts.log ?? ((): void => undefined);
  const staged = opts.staged ?? false;
  const gateFailingRules = [...(opts.gateFailingRules ?? [])];
  const system = buildFindSystem(gateFailingRules);
  const base = await detectBase(cwd, opts.base);
  const { files, totalCandidates, untracked } = await collectChangedFiles(
    cwd,
    base,
    staged
  );

  log(`reviewing ${files.length} changed file(s) vs ${base}`);

  if (totalCandidates > files.length) {
    log(
      `⚠ coverage: ${totalCandidates} changed files, reviewing the first ${files.length} (MAX_FILES=${MAX_FILES})`
    );
  }

  if (gateFailingRules.length > 0) {
    log(`gate-aware: skipping ${gateFailingRules.length} failing gate rule(s)`);
  }

  // In-process TS LanguageService (null without a tsconfig) — powers the
  // caller blast-radius signal. Built once; falls back gracefully when absent.
  const svc: TsService | null = await buildTsService(cwd);
  const raw: IRepoFinding[] = [];
  const truncatedFiles: string[] = [];
  let preexisting = 0;

  // Sequential on purpose: this harness targets a single local-model server, so
  // we don't fan out concurrent requests that would swamp it. Each file is
  // isolated in try/catch so one bad file can't abort the whole review.
  for (const file of files) {
    const { diff, truncated, ranges } = await fileDiff(
      cwd,
      base,
      file,
      staged,
      untracked.has(file)
    );

    if (truncated) {
      truncatedFiles.push(file);
    }

    const found = await safeFind(provider, system, svc, cwd, file, diff, log);

    // Keep only findings ON a changed line — a finding on pre-existing code the
    // change didn't touch is not a regression in THIS change. Skip the filter
    // when no hunks parsed (can't tell), so we never silently drop everything.
    const onChange =
      ranges.length === 0
        ? found
        : found.filter((f) => lineInRanges(f.line, ranges));

    preexisting += found.length - onChange.length;

    log(
      `  ${file}: ${onChange.length} candidate finding(s)${
        found.length !== onChange.length
          ? ` (${found.length - onChange.length} on pre-existing lines, skipped)`
          : ""
      }`
    );
    raw.push(...onChange);
  }

  const doVerify = opts.verify ?? true;
  const verified: IVerifiedFinding[] = [];
  let rejected = 0;

  for (const finding of raw) {
    const result = doVerify
      ? await safeVerify(provider, cwd, finding, log)
      : { ...finding, verified: true, verdict: "(unverified)" };

    if (result.verified) {
      verified.push(result);
    } else {
      rejected += 1;
    }
  }

  log(`verified ${verified.length} finding(s), rejected ${rejected}`);

  return {
    base,
    changedFiles: files,
    findings: verified,
    rejected,
    gateFailingRules,
    totalChangedFiles: totalCandidates,
    truncatedFiles,
    preexisting,
  };
}

const SEVERITY_RANK: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/** Render a report as plain text for the CLI. */
export function formatReport(report: IReviewReport): string {
  if (report.changedFiles.length === 0) {
    return "No changed source files to review.";
  }

  // The gate-aware note must show even when nothing was found — otherwise a
  // `--with-gate` run that skipped rules reads as "all clear" with no hint why.
  const gateFailingRules = report.gateFailingRules ?? [];
  const gateNote =
    gateFailingRules.length > 0
      ? [
          `(gate-aware: skipped ${gateFailingRules.length} failing gate rule(s) the gate already covers)`,
        ]
      : [];

  // Coverage warnings: a capped/truncated run must NOT read as if it reviewed
  // everything. Shown in BOTH the clean and the findings branch.
  const reviewed = report.changedFiles.length;
  const total = report.totalChangedFiles ?? reviewed;
  const truncated = report.truncatedFiles ?? [];
  const coverageNotes: string[] = [];

  if (total > reviewed) {
    coverageNotes.push(
      `⚠ coverage: reviewed ${reviewed} of ${total} changed file(s); ${total - reviewed} not reviewed (cap ${MAX_FILES}) — re-run scoped to cover them.`
    );
  }

  if (truncated.length > 0) {
    coverageNotes.push(
      `⚠ ${truncated.length} file(s) had diffs truncated at ${DIFF_CHARS} chars — review saw only a prefix: ${truncated.join(", ")}`
    );
  }

  if (report.findings.length === 0) {
    return [
      `No functional issues found across ${reviewed} reviewed file(s) (${report.rejected} candidate(s) rejected on verification).`,
      ...coverageNotes,
      ...gateNote,
    ].join("\n");
  }

  const sorted = [...report.findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  );
  const lines = sorted.map(
    (f) =>
      `${f.severity.toUpperCase()} ${f.file}:${f.line} [${f.lens}]\n  ${f.claim}\n  → ${f.reason}`
  );

  return [
    `Review of ${reviewed} changed file(s) vs ${report.base}:`,
    `${report.findings.length} verified finding(s), ${report.rejected} rejected.`,
    ...coverageNotes,
    ...gateNote,
    "",
    ...lines,
  ].join("\n");
}
