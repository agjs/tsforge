import type { IPanel } from "./registry";
import { reviewerInvoke, type IInvokeDeps } from "./invoke";
import { aggregate, type IVerdict } from "./aggregate";
import { RUBRIC_VERSION, type IReviewRequest, type IValidateSummary } from "./schema";

export const DEFAULT_MAX_FILES = 40;
export const DEFAULT_MAX_CHARS = 120000;
const GENERIC_INTENTS = new Set(["wip", "fix", "wip fix", "update", "changes", ""]);

export interface IGitRunner {
  (args: string[]): Promise<{ stdout: string; code: number }>;
}

export interface IValidateRunner {
  (): Promise<IValidateSummary>;
}

export interface IGatherDeps {
  git: IGitRunner;
  validate: IValidateRunner;
}

export interface IGatherOptions {
  base?: string;
  intent?: string;
  maxFiles: number;
  maxChars: number;
}

export type GatherResult =
  | { kind: "request"; request: IReviewRequest }
  | { kind: "block"; reason: string };

async function resolveBase(git: IGitRunner, explicit: string | undefined): Promise<string> {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const res = await git(["merge-base", "main", "HEAD"]);
  const base = res.stdout.trim();

  return base.length > 0 ? base : "HEAD~1";
}

async function resolveIntent(git: IGitRunner, explicit: string | undefined): Promise<string | null> {
  if (explicit !== undefined && explicit.trim().length > 0) {
    return explicit.trim();
  }

  const subject = (await git(["log", "-1", "--format=%s"])).stdout.trim();

  return GENERIC_INTENTS.has(subject.toLowerCase()) ? null : subject;
}

async function changedFiles(git: IGitRunner, base: string): Promise<string[]> {
  const res = await git(["diff", "--name-only", `${base}...HEAD`]);

  return res.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

export async function gatherChange(deps: IGatherDeps, opts: IGatherOptions): Promise<GatherResult> {
  const validateSummary = await deps.validate();

  if (!validateSummary.passed) {
    return {
      kind: "block",
      reason: `validate failed (${String(validateSummary.failCount)} errors) — fix the gate before review:\n${validateSummary.firstErrors.join("\n")}`,
    };
  }

  const base = await resolveBase(deps.git, opts.base);
  const intent = await resolveIntent(deps.git, opts.intent);

  if (intent === null) {
    return { kind: "block", reason: "intent is empty or generic — pass --intent \"what this change does and why\"" };
  }

  const files = await changedFiles(deps.git, base);

  if (files.length > opts.maxFiles) {
    return { kind: "block", reason: `diff too large (${String(files.length)} files > ${String(opts.maxFiles)}) — split the PR` };
  }

  const diff = (await deps.git(["diff", `${base}...HEAD`])).stdout;

  if (diff.length > opts.maxChars) {
    return { kind: "block", reason: `diff too large (${String(diff.length)} chars > ${String(opts.maxChars)}) — split the PR` };
  }

  return {
    kind: "request",
    request: { title: intent.slice(0, 80), intent, diff, validateSummary, rubricVersion: RUBRIC_VERSION },
  };
}

export interface IRunDeps extends IGatherDeps, IInvokeDeps {
  panel: IPanel;
  identity: string;
}

function blockedVerdict(reason: string, identity: string): IVerdict {
  return { blocked: true, reason, reviewers: { ok: 0, errored: 0 }, ranked: [], perReviewer: [], identity };
}

export async function runHarnessReview(deps: IRunDeps, opts: IGatherOptions): Promise<IVerdict> {
  const gathered = await gatherChange(deps, opts);

  if (gathered.kind === "block") {
    return blockedVerdict(gathered.reason, deps.identity);
  }

  const outcomes = await reviewerInvoke(deps.panel, gathered.request, {
    makeProvider: deps.makeProvider,
    runBinary: deps.runBinary,
  });

  return aggregate(outcomes, { minReviewers: deps.panel.minReviewers, identity: deps.identity });
}
