import { isAbsolute, join } from "node:path";
import { runArgvCommand } from "../../lib/fs";
import { isRecord, isArray } from "../../lib/guards";
import { extractJson } from "../../lib/json";
import type { IProvider } from "../../inference";
import { LENSES, lensRubric } from "./lenses";
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

/** Changed source files in the working tree vs `base` (or staged-only). */
async function changedFiles(
  cwd: string,
  base: string,
  staged: boolean
): Promise<string[]> {
  const argv = staged
    ? ["diff", "--name-only", "--staged"]
    : ["diff", "--name-only", base];
  const out = await gitText(cwd, argv);

  return out
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => /\.(ts|tsx|js|jsx|mts|cts)$/.test(f))
    .slice(0, MAX_FILES);
}

async function fileDiff(
  cwd: string,
  base: string,
  file: string,
  staged: boolean
): Promise<string> {
  const argv = staged
    ? ["diff", "--staged", "--", file]
    : ["diff", base, "--", file];
  const out = await gitText(cwd, argv);

  return out.slice(0, DIFF_CHARS);
}

const FIND_SYSTEM = [
  "You are a senior engineer reviewing a code change for FUNCTIONAL problems: logic errors, regressions, missed edge cases, and broken business rules.",
  "A separate automated gate already covers types, structure, and style — do NOT report those. Only functional/behavioural issues.",
  "Review the change THROUGH these lenses:",
  LENSES.map(lensRubric).join("\n\n"),
  "Rules: report ONLY concrete problems you can tie to a specific changed line. If the change looks correct, return an empty list. Never speculate — prefer silence over a guess.",
  'Respond with ONLY JSON: {"findings":[{"line":<number>,"severity":"error|warning|info","lens":"<lens id>","claim":"<what is wrong>","reason":"<why>"}]}.',
].join("\n\n");

/** One find pass over a single changed file's diff (per-file decomposition keeps
 *  a small model in its reliable zone). */
async function findInFile(
  provider: IProvider,
  file: string,
  diff: string
): Promise<IRepoFinding[]> {
  if (diff.length === 0) {
    return [];
  }

  const res = await provider.complete(
    [
      { role: "system", content: FIND_SYSTEM },
      {
        role: "user",
        content: `File: ${file}\n\nDiff (base → working tree):\n${diff}`,
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
      line: typeof line === "number" && line > 0 ? line : 1,
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
  const base = await detectBase(cwd, opts.base);
  const files = await changedFiles(cwd, base, staged);

  log(`reviewing ${files.length} changed file(s) vs ${base}`);

  const raw: IRepoFinding[] = [];

  for (const file of files) {
    const diff = await fileDiff(cwd, base, file, staged);
    const found = await findInFile(provider, file, diff);

    log(`  ${file}: ${found.length} candidate finding(s)`);
    raw.push(...found);
  }

  const doVerify = opts.verify ?? true;
  const verified: IVerifiedFinding[] = [];
  let rejected = 0;

  for (const finding of raw) {
    const result = doVerify
      ? await verifyFinding(provider, cwd, finding)
      : { ...finding, verified: true, verdict: "(unverified)" };

    if (result.verified) {
      verified.push(result);
    } else {
      rejected += 1;
    }
  }

  log(`verified ${verified.length} finding(s), rejected ${rejected}`);

  return { base, changedFiles: files, findings: verified, rejected };
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

  if (report.findings.length === 0) {
    return `No functional issues found across ${report.changedFiles.length} changed file(s) (${report.rejected} candidate(s) rejected on verification).`;
  }

  const sorted = [...report.findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  );
  const lines = sorted.map(
    (f) =>
      `${f.severity.toUpperCase()} ${f.file}:${f.line} [${f.lens}]\n  ${f.claim}\n  → ${f.reason}`
  );

  return [
    `Review of ${report.changedFiles.length} changed file(s) vs ${report.base}:`,
    `${report.findings.length} verified finding(s), ${report.rejected} rejected.`,
    "",
    ...lines,
  ].join("\n");
}
