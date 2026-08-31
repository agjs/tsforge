import { runArgvCommand } from "../../lib/fs";
import type { IRepoFinding, IReviewReport, Severity } from "./review.types";

/**
 * Shared review helpers: locating the change (base + changed files), collapsing
 * duplicate findings, and rendering a report as plain text. The reviewer itself is
 * the AGENTIC engine in `review-agents.ts` — it reads the whole change and
 * navigates the codebase with tools, so there is no per-file / capped find pass.
 */

/** Run `git` with an explicit argv (no shell); return trimmed stdout, "" on error. */
async function gitText(cwd: string, argv: string[]): Promise<string> {
  const res = await runArgvCommand(cwd, ["git", ...argv]);

  return res.exitCode === 0 ? res.stdout.trim() : "";
}

/** The ref to diff the working tree against: explicit override, else the
 *  merge-base with the default branch, else HEAD (already on the default branch). */
export async function detectBase(
  cwd: string,
  override?: string
): Promise<string> {
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

export interface IChangeSet {
  /** Changed source files (deduped, tracked + brand-new untracked). */
  files: string[];
  /** Total candidate files (== files.length; kept for report bookkeeping). */
  totalCandidates: number;
}

/** Changed source files in the working tree vs `base` (or staged-only), INCLUDING
 *  brand-new untracked files. `git diff` against a ref only sees TRACKED files, so
 *  without unioning `ls-files --others` a newly created (never `git add`ed) source
 *  file is silently skipped. Staged mode reviews the index only (new files already
 *  tracked there). No cap — the reviewer agent reads the whole change. */
export async function collectChangedFiles(
  cwd: string,
  base: string,
  staged: boolean
): Promise<IChangeSet> {
  // --diff-filter=d drops deleted files — no point reviewing a file that's gone.
  const trackedArgv = staged
    ? ["diff", "--name-only", "--diff-filter=d", "--staged"]
    : ["diff", "--name-only", "--diff-filter=d", base];
  const tracked = splitFiles(await gitText(cwd, trackedArgv));

  const untracked = staged
    ? []
    : splitFiles(
        await gitText(cwd, ["ls-files", "--others", "--exclude-standard"])
      );

  const all: string[] = [];
  const seen = new Set<string>();

  for (const file of [...tracked, ...untracked]) {
    if (!seen.has(file)) {
      seen.add(file);
      all.push(file);
    }
  }

  return { files: all, totalCandidates: all.length };
}

const SEVERITY_RANK: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/** Collapse duplicate findings from a reviewer panel: same file+line+lens is one
 *  issue, kept at its highest severity (first-wins on a tie). */
export function dedupeFindings(
  findings: readonly IRepoFinding[]
): IRepoFinding[] {
  const byKey = new Map<string, IRepoFinding>();

  for (const f of findings) {
    const key = `${f.file}:${String(f.line)}:${f.lens}`;
    const prev = byKey.get(key);

    if (
      prev === undefined ||
      SEVERITY_RANK[f.severity] < SEVERITY_RANK[prev.severity]
    ) {
      byKey.set(key, f);
    }
  }

  return [...byKey.values()];
}

/** Render a report as plain text (the CLI/pipe path and the `/reviewfix` seed). */
export function formatReport(report: IReviewReport): string {
  if (report.changedFiles.length === 0) {
    return "No changed source files to review.";
  }

  const reviewed = report.changedFiles.length;
  const gateFailingRules = report.gateFailingRules ?? [];
  const failedReviewers = report.failedReviewers ?? [];
  const failedNote =
    failedReviewers.length > 0
      ? [
          `(${String(failedReviewers.length)} reviewer(s) failed: ${failedReviewers.join(", ")})`,
        ]
      : [];
  const gateNote =
    gateFailingRules.length > 0
      ? [
          `(gate-aware: skipped ${gateFailingRules.length} failing gate rule(s) the gate already covers)`,
        ]
      : [];

  if (report.findings.length === 0) {
    return [
      `No issues found across ${reviewed} reviewed file(s).`,
      ...failedNote,
      ...gateNote,
    ].join("\n");
  }

  const sorted = [...report.findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  );
  const lines = sorted.map((f) => {
    const head = `${f.severity.toUpperCase()} ${f.file}:${f.line} [${f.lens}]\n  ${f.claim}\n  → ${f.reason}`;

    return f.suggestedFix === undefined
      ? head
      : `${head}\n  fix: ${f.suggestedFix}`;
  });

  return [
    `Review of ${reviewed} changed file(s) vs ${report.base}:`,
    `${report.findings.length} finding(s).`,
    ...failedNote,
    ...gateNote,
    "",
    ...lines,
  ].join("\n");
}

/** Render a report as either a single line of JSON (a stable, parseable
 *  contract for downstream tooling — e.g. a CI integration that turns
 *  findings into inline PR comments) or the existing plain-text format.
 *  JSON output is exactly `JSON.stringify(report)`: no re-shaping, so the
 *  contract is the same `IReviewReport` type callers of `review()` already
 *  see, not a second, drifting shape. */
export function renderReport(report: IReviewReport, json: boolean): string {
  return json ? JSON.stringify(report) : formatReport(report);
}
