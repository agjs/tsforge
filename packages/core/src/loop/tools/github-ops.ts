import { runArgvCommand } from "../../lib/fs";
import { LOOP_LIMITS } from "../loop.constants";
import { flags } from "../../config";
import { str, reject, type IToolContext } from "./tool-context";
import {
  unsafe,
  intArg,
  capHead,
  capTail,
  pick,
  DEFAULT_VCS_DEPS,
  type IVcsDeps,
} from "./vcs-common";

const GH_MISSING = "the gh CLI is not installed or not on PATH";

/** The github capability = the user's consent to git/GitHub writes. */
const CAPABILITY_OFF =
  "the GitHub capability is off — install and authenticate the gh CLI " +
  "(`gh auth login`) and ensure TSFORGE_NO_GITHUB is unset.";

/** GraphQL to pull a PR's review threads with their resolve-ids + comments. */
const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{
          id isResolved isOutdated path line
          comments(first:20){ nodes{ author{login} body } }
        }
      }
    }
  }
}`;

/** GraphQL mutation that resolves ONE review thread by its node id. */
const RESOLVE_THREAD_MUTATION = `mutation($id:ID!){
  resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } }
}`;

function jsonParse(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);

    return parsed;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A model-supplied PR selector (number or branch); "" ⇒ current branch's PR. */
function prSelector(args: Record<string, unknown>): { pr: string } | string {
  const pr = str(args, "pr").trim();

  if (pr.length > 0 && unsafe(pr)) {
    return "github_read: unsafe `pr` selector";
  }

  return { pr };
}

function maxOf(args: Record<string, unknown>): number {
  return intArg(args, "maxChars") ?? LOOP_LIMITS.maxToolOutputChars;
}

// ── reads ──────────────────────────────────────────────────────────────────

async function prView(
  ctx: IToolContext,
  deps: IVcsDeps,
  pr: string,
  max: number
): Promise<string> {
  const argv = ["gh", "pr", "view"];

  if (pr.length > 0) {
    argv.push(pr);
  }

  argv.push(
    "--json",
    "number,title,state,isDraft,headRefName,baseRefName,mergeable,reviewDecision,url"
  );

  const res = await run(ctx, deps, argv);

  if (typeof res === "string") {
    return res;
  }

  const data = jsonParse(res.stdout);

  if (!isRecord(data)) {
    return capHead(pick(res.stdout, res.stderr, "(no PR found)"), max);
  }

  const review = String(data.reviewDecision);
  const lines = [
    `#${String(data.number)} ${String(data.title)}`,
    `state: ${String(data.state)}${data.isDraft === true ? " (draft)" : ""}`,
    `branch: ${String(data.headRefName)} → ${String(data.baseRefName)}`,
    `mergeable: ${String(data.mergeable)}  review: ${review.length > 0 ? review : "NONE"}`,
    String(data.url),
  ];

  return capHead(lines.join("\n"), max);
}

async function prDiff(
  ctx: IToolContext,
  deps: IVcsDeps,
  pr: string,
  max: number
): Promise<string> {
  const argv = ["gh", "pr", "diff"];

  if (pr.length > 0) {
    argv.push(pr);
  }

  const res = await run(ctx, deps, argv);

  return typeof res === "string"
    ? res
    : capHead(pick(res.stdout, res.stderr, "(no diff)"), max);
}

async function checks(
  ctx: IToolContext,
  deps: IVcsDeps,
  pr: string,
  max: number
): Promise<string> {
  const argv = ["gh", "pr", "checks"];

  if (pr.length > 0) {
    argv.push(pr);
  }

  argv.push("--json", "name,state,bucket,link");

  // `gh pr checks` exits non-zero when a check is failing/pending — that is a
  // STATUS, not a tool error, so we read the output regardless of exit code.
  const res = await run(ctx, deps, argv, { tolerateNonZero: true });

  if (typeof res === "string") {
    return res;
  }

  const data = jsonParse(res.stdout);

  if (!Array.isArray(data) || data.length === 0) {
    return "no CI checks reported for this PR";
  }

  const lines = data.filter(isRecord).map((c) => {
    const mark =
      c.bucket === "pass"
        ? "✓"
        : c.bucket === "fail"
          ? "✗"
          : c.bucket === "pending"
            ? "…"
            : "•";

    return `${mark} ${String(c.name)} — ${String(c.state)}`;
  });

  return capHead(lines.join("\n"), max);
}

/** Resolve the branch a `failing_logs`/run query should target: an explicit
 *  non-numeric selector is a branch; otherwise the current checked-out branch. */
async function branchFor(
  ctx: IToolContext,
  deps: IVcsDeps,
  pr: string
): Promise<string | null> {
  if (pr.length > 0 && !/^\d+$/.test(pr)) {
    return pr;
  }

  const res = await deps.run(ctx.cwd, [
    "git",
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);

  const branch = res.stdout.trim();

  return branch.length > 0 && branch !== "HEAD" ? branch : null;
}

async function failingLogs(
  ctx: IToolContext,
  deps: IVcsDeps,
  pr: string,
  max: number
): Promise<string> {
  const branch = await branchFor(ctx, deps, pr);

  if (branch === null) {
    return "github_read: could not determine the branch for CI logs";
  }

  const listRes = await run(ctx, deps, [
    "gh",
    "run",
    "list",
    "--branch",
    branch,
    "--limit",
    "1",
    "--json",
    "databaseId,conclusion,status,workflowName",
  ]);

  if (typeof listRes === "string") {
    return listRes;
  }

  const runs = jsonParse(listRes.stdout);

  if (!Array.isArray(runs) || runs.length === 0 || !isRecord(runs[0])) {
    return `no CI runs found for branch '${branch}'`;
  }

  const id = runs[0].databaseId;

  if (typeof id !== "number") {
    return `no CI run id for branch '${branch}'`;
  }

  const logRes = await run(
    ctx,
    deps,
    ["gh", "run", "view", String(id), "--log-failed"],
    { tolerateNonZero: true }
  );

  if (typeof logRes === "string") {
    return logRes;
  }

  const body = logRes.stdout.trim();

  // Tail-cap: a CI failure's cause is at the END of the log.
  return body.length > 0
    ? capTail(body, max)
    : `run ${String(id)} (${String(runs[0].status)}/${String(runs[0].conclusion)}) reported no failing-step logs`;
}

/** owner/repo for the current repo, via `gh repo view`. */
async function nameWithOwner(
  ctx: IToolContext,
  deps: IVcsDeps
): Promise<{ owner: string; repo: string } | string> {
  const res = await run(ctx, deps, [
    "gh",
    "repo",
    "view",
    "--json",
    "nameWithOwner",
  ]);

  if (typeof res === "string") {
    return res;
  }

  const data = jsonParse(res.stdout);
  const slug = isRecord(data) ? String(data.nameWithOwner) : "";
  const [owner, repo] = slug.split("/");

  return owner !== undefined &&
    owner.length > 0 &&
    repo !== undefined &&
    repo.length > 0
    ? { owner, repo }
    : "github_read: could not resolve the current repository";
}

/** The PR number for the selector (numeric selector as-is, else look it up). */
async function prNumber(
  ctx: IToolContext,
  deps: IVcsDeps,
  pr: string
): Promise<number | string> {
  if (/^\d+$/.test(pr)) {
    return Number(pr);
  }

  const argv = ["gh", "pr", "view"];

  if (pr.length > 0) {
    argv.push(pr);
  }

  argv.push("--json", "number");

  const res = await run(ctx, deps, argv);

  if (typeof res === "string") {
    return res;
  }

  const data = jsonParse(res.stdout);

  return isRecord(data) && typeof data.number === "number"
    ? data.number
    : "github_read: could not resolve the PR number";
}

function formatThreads(nodes: unknown[]): string {
  const unresolved = nodes
    .filter(isRecord)
    .filter((t) => t.isResolved !== true);

  if (unresolved.length === 0) {
    return "no unresolved review threads 🎉";
  }

  const blocks = unresolved.map((t) => {
    const where =
      typeof t.path === "string"
        ? `${t.path}${typeof t.line === "number" ? `:${String(t.line)}` : ""}`
        : "(general)";
    const commentsNode = isRecord(t.comments) ? t.comments.nodes : null;
    const comments = Array.isArray(commentsNode) ? commentsNode : [];
    const rendered = comments
      .filter(isRecord)
      .map((c) => {
        const login = isRecord(c.author) ? String(c.author.login) : "?";

        return `    ${login}: ${String(c.body).trim()}`;
      })
      .join("\n");

    return `[${String(t.id)}] ${where}${t.isOutdated === true ? " (outdated)" : ""}\n${rendered}`;
  });

  return `${String(unresolved.length)} unresolved thread(s) — resolve each with github_write resolve_thread <id>:\n\n${blocks.join("\n\n")}`;
}

async function reviewThreads(
  ctx: IToolContext,
  deps: IVcsDeps,
  pr: string,
  max: number
): Promise<string> {
  const repo = await nameWithOwner(ctx, deps);

  if (typeof repo === "string") {
    return repo;
  }

  const number = await prNumber(ctx, deps, pr);

  if (typeof number === "string") {
    return number;
  }

  const res = await run(ctx, deps, [
    "gh",
    "api",
    "graphql",
    "-f",
    `query=${REVIEW_THREADS_QUERY}`,
    "-f",
    `owner=${repo.owner}`,
    "-f",
    `repo=${repo.repo}`,
    "-F",
    `number=${String(number)}`,
  ]);

  if (typeof res === "string") {
    return res;
  }

  const data = jsonParse(res.stdout);
  const nodes =
    isRecord(data) &&
    isRecord(data.data) &&
    isRecord(data.data.repository) &&
    isRecord(data.data.repository.pullRequest) &&
    isRecord(data.data.repository.pullRequest.reviewThreads)
      ? data.data.repository.pullRequest.reviewThreads.nodes
      : null;

  if (!Array.isArray(nodes)) {
    return capHead(pick(res.stdout, res.stderr, "(no threads)"), max);
  }

  return capHead(formatThreads(nodes), max);
}

// ── writes ─────────────────────────────────────────────────────────────────

/** Soft lint of a PR/comment body: reject empty; nudge on the banned mechanics
 *  (line/file counts) the guidance forbids. Returns a reason string, or null. */
export function lintPrBody(body: string): string | null {
  if (body.trim().length === 0) {
    return "the body is empty — say WHY, WHAT, and the OUTCOME in plain language";
  }

  if (/\b\d+\s+(lines?|files?)\b/i.test(body) || /\bline count\b/i.test(body)) {
    return "drop the line/file counts — describe the change for a human; the reviewer reads the diff for mechanics";
  }

  return null;
}

async function prCreate(
  ctx: IToolContext,
  deps: IVcsDeps,
  args: Record<string, unknown>
): Promise<string> {
  const title = str(args, "title");
  const body = str(args, "body");
  const base = str(args, "base");

  if (title.trim().length === 0) {
    return reject(ctx, "github_write", "pr_create: needs a `title`");
  }

  const bodyLint = lintPrBody(body);

  if (bodyLint !== null) {
    return reject(ctx, "github_write", `pr_create: ${bodyLint}`);
  }

  if (base.length > 0 && unsafe(base)) {
    return reject(ctx, "github_write", "pr_create: unsafe `base` branch");
  }

  const argv = ["gh", "pr", "create", "--title", title, "--body", body];

  if (base.length > 0) {
    argv.push("--base", base);
  }

  if (args.draft === true) {
    argv.push("--draft");
  }

  const res = await run(ctx, deps, argv);

  return typeof res === "string"
    ? res
    : pick(res.stdout.trim(), res.stderr.trim(), "PR created");
}

async function prComment(
  ctx: IToolContext,
  deps: IVcsDeps,
  args: Record<string, unknown>
): Promise<string> {
  const body = str(args, "body");
  const sel = prSelector(args);

  if (typeof sel === "string") {
    return reject(
      ctx,
      "github_write",
      sel.replace("github_read", "github_write")
    );
  }

  const bodyLint = lintPrBody(body);

  if (bodyLint !== null) {
    return reject(ctx, "github_write", `pr_comment: ${bodyLint}`);
  }

  const argv = ["gh", "pr", "comment"];

  if (sel.pr.length > 0) {
    argv.push(sel.pr);
  }

  argv.push("--body", body);

  const res = await run(ctx, deps, argv);

  return typeof res === "string"
    ? res
    : pick(res.stdout.trim(), "comment added");
}

async function resolveThread(
  ctx: IToolContext,
  deps: IVcsDeps,
  args: Record<string, unknown>
): Promise<string> {
  const threadId = str(args, "threadId").trim();

  if (threadId.length === 0 || unsafe(threadId)) {
    return reject(
      ctx,
      "github_write",
      "resolve_thread: needs a `threadId` from github_read review_threads"
    );
  }

  const res = await run(ctx, deps, [
    "gh",
    "api",
    "graphql",
    "-f",
    `query=${RESOLVE_THREAD_MUTATION}`,
    "-f",
    `id=${threadId}`,
  ]);

  if (typeof res === "string") {
    return res;
  }

  const data = jsonParse(res.stdout);
  const resolved =
    isRecord(data) &&
    isRecord(data.data) &&
    isRecord(data.data.resolveReviewThread) &&
    isRecord(data.data.resolveReviewThread.thread) &&
    data.data.resolveReviewThread.thread.isResolved === true;

  return resolved
    ? `thread ${threadId} resolved`
    : `resolve_thread: gh did not confirm resolution\n${capHead(pick(res.stdout, res.stderr), 400)}`;
}

// ── shared runner ────────────────────────────────────────────────────────────

interface IRunOpts {
  tolerateNonZero?: boolean;
}

/** Run a gh/git argv and normalize the common failures to a clear string, or
 *  return the raw result for the caller to shape. Never throws. */
async function run(
  ctx: IToolContext,
  deps: IVcsDeps,
  argv: string[],
  opts: IRunOpts = {}
): Promise<IShellRunLike | string> {
  const res = await deps.run(
    ctx.cwd,
    argv,
    ctx.signal === undefined ? {} : { signal: ctx.signal }
  );

  if (res.exitCode === 127) {
    return GH_MISSING;
  }

  const combined = `${res.stdout}${res.stderr}`;

  if (/gh auth login|not logged into/i.test(combined)) {
    return "github: not authenticated — run `gh auth login`";
  }

  if (res.exitCode !== 0 && opts.tolerateNonZero !== true) {
    const detail = pick(res.stderr.trim(), res.stdout.trim());

    return detail.length > 0
      ? detail
      : `command failed (exit ${String(res.exitCode)})`;
  }

  return res;
}

interface IShellRunLike {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/**
 * Read-only GitHub inspection via the `gh` CLI (pr_view / pr_diff / checks /
 * failing_logs / review_threads). No `ctx.github` guard — reads are policy-allowed
 * in every mode (vcs_read); if the capability is off the tool simply isn't
 * advertised. Never throws; a missing/unauthed gh degrades to a clear message.
 */
export async function doGithubRead(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: IVcsDeps = DEFAULT_VCS_DEPS
): Promise<string> {
  const op = str(args, "op");
  const sel = prSelector(args);

  if (typeof sel === "string") {
    return reject(ctx, "github_read", sel);
  }

  const max = maxOf(args);

  ctx.report({ kind: "tool", task: ctx.task, message: `github_read ${op}` });

  switch (op) {
    case "pr_view":
      return prView(ctx, deps, sel.pr, max);
    case "pr_diff":
      return prDiff(ctx, deps, sel.pr, max);
    case "checks":
      return checks(ctx, deps, sel.pr, max);
    case "failing_logs":
      return failingLogs(ctx, deps, sel.pr, max);
    case "review_threads":
      return reviewThreads(ctx, deps, sel.pr, max);
    default:
      return reject(
        ctx,
        "github_read",
        `unknown op '${op}' (use pr_view|pr_diff|checks|failing_logs|review_threads)`
      );
  }
}

/**
 * GitHub WRITE via `gh` — pr_create / pr_comment / resolve_thread. Gated by the
 * `github` capability (consent) AND the vcs_write policy kind. NEVER merges or
 * closes a PR (human-only). Fails closed when the capability is off, even on a
 * salvaged/forced call. Never throws.
 */
export async function doGithubWrite(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: IVcsDeps = DEFAULT_VCS_DEPS
): Promise<string> {
  if (ctx.github !== true) {
    return reject(ctx, "github_write", CAPABILITY_OFF);
  }

  const op = str(args, "op");

  ctx.report({ kind: "tool", task: ctx.task, message: `github_write ${op}` });

  switch (op) {
    case "pr_create":
      return prCreate(ctx, deps, args);
    case "pr_comment":
      return prComment(ctx, deps, args);
    case "resolve_thread":
      return resolveThread(ctx, deps, args);
    default:
      return reject(
        ctx,
        "github_write",
        `unknown op '${op}' (use pr_create|pr_comment|resolve_thread)`
      );
  }
}

// ── capability detection ─────────────────────────────────────────────────────

export interface ICapabilityDeps {
  run: IVcsDeps["run"];
  which: (cmd: string) => string | null;
}

const DEFAULT_CAP_DEPS: ICapabilityDeps = {
  run: runArgvCommand,
  which: (cmd) => Bun.which(cmd),
};

/**
 * Resolve the `github` capability = the user's consent to git/GitHub operations.
 * True IFF: the TSFORGE_NO_GITHUB kill-switch is unset, the `gh` CLI is on PATH,
 * and `gh auth status` reports an authenticated account. Mirrors
 * `resolveImageCapabilityFlags`: async, resolved once by each driver, and any
 * throw is swallowed to `false` (fail closed). Never throws.
 */
export async function resolveGithubCapability(
  deps: ICapabilityDeps = DEFAULT_CAP_DEPS,
  cwd: string = process.cwd()
): Promise<boolean> {
  try {
    if (flags.noGithub()) {
      return false;
    }

    if (deps.which("gh") === null) {
      return false;
    }

    const res = await deps.run(cwd, ["gh", "auth", "status"]);

    return res.exitCode === 0;
  } catch {
    return false;
  }
}
