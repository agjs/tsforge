import { createHash } from "node:crypto";
import type { IPanel } from "./registry";
import { reviewerInvoke, type IInvokeDeps } from "./invoke";
import { aggregate, type IVerdict } from "./aggregate";
import {
  RUBRIC_VERSION,
  type IReviewRequest,
  type IValidateSummary,
} from "./schema";

export const DEFAULT_MAX_FILES = 40;
export const DEFAULT_MAX_CHARS = 120000;
const GENERIC_INTENTS = new Set([
  "wip",
  "fix",
  "wip fix",
  "update",
  "changes",
  "",
]);

export type IGitRunner = (
  args: string[]
) => Promise<{ stdout: string; code: number }>;

export type IValidateRunner = () => Promise<IValidateSummary>;

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

async function resolveBase(
  git: IGitRunner,
  explicit: string | undefined
): Promise<string> {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const res = await git(["merge-base", "main", "HEAD"]);
  const base = res.stdout.trim();

  return base.length > 0 ? base : "HEAD~1";
}

async function resolveIntent(
  git: IGitRunner,
  explicit: string | undefined
): Promise<string | null> {
  if (explicit !== undefined && explicit.trim().length > 0) {
    return explicit.trim();
  }

  const subject = (await git(["log", "-1", "--format=%s"])).stdout.trim();

  return GENERIC_INTENTS.has(subject.toLowerCase()) ? null : subject;
}

export interface IResolvedReviewInputs {
  /** The base to hand `runHarnessReview` so its diff matches what `diffHash` hashed. */
  base: string;
  /** The resolved intent text (commit subject when the flag is omitted), or null when
   *  empty/generic (the review will block on it). */
  intent: string | null;
  /** sha256 of the ACTUAL reviewed diff (`${base}...HEAD`), or null when the diff could
   *  NOT be computed (git failed). A null hash means the caller MUST skip the cache
   *  entirely — never key on a movable ref as a fallback (that is the very bug this
   *  resolver exists to kill). */
  diffHash: string | null;
}

/**
 * Resolve the review's base + intent AND fingerprint the exact diff the reviewers will
 * see, so the verdict cache can key on the real review inputs. Keying on the raw flags is
 * unsound: an omitted `--base` resolves to `merge-base main HEAD` and a named ref like
 * `main` is resolved at review time, so the SAME flags can denote a DIFFERENT diff after
 * `main` moves; an omitted `--intent` comes from the commit subject, which an amend
 * changes.
 *
 * Keying on a base SHA is NOT enough either: the diff is `${base}...HEAD` (three-dot, a
 * merge-base diff), so a rebase that shifts `merge-base(base, HEAD)` changes the reviewed
 * diff while the base ref, the final tree, and the subject all stay identical. The only
 * fingerprint that captures every one of those is a hash of the reviewed diff itself —
 * exactly the bytes the reviewers judge. The same resolved `base` is handed to the review,
 * so the diff the key hashed and the diff the review reads are the same command.
 *
 * If the diff cannot be computed (git error), `diffHash` is null and the caller skips the
 * cache — a failure must never silently fall back to keying on the movable ref.
 */
export async function resolveReviewInputs(
  git: IGitRunner,
  base: string | undefined,
  intent: string | undefined
): Promise<IResolvedReviewInputs> {
  const baseRef = await resolveBase(git, base);
  const intentText = await resolveIntent(git, intent);
  const diff = await git(["diff", `${baseRef}...HEAD`]);
  const diffHash =
    diff.code === 0
      ? createHash("sha256").update(diff.stdout).digest("hex")
      : null;

  return { base: baseRef, intent: intentText, diffHash };
}

async function changedFiles(git: IGitRunner, base: string): Promise<string[]> {
  const res = await git(["diff", "--name-only", `${base}...HEAD`]);

  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export async function gatherChange(
  deps: IGatherDeps,
  opts: IGatherOptions
): Promise<GatherResult> {
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
    return {
      kind: "block",
      reason:
        'intent is empty or generic — pass --intent "what this change does and why"',
    };
  }

  const files = await changedFiles(deps.git, base);

  if (files.length > opts.maxFiles) {
    return {
      kind: "block",
      reason: `diff too large (${String(files.length)} files > ${String(opts.maxFiles)}) — split the PR`,
    };
  }

  const diff = (await deps.git(["diff", `${base}...HEAD`])).stdout;

  if (diff.length > opts.maxChars) {
    return {
      kind: "block",
      reason: `diff too large (${String(diff.length)} chars > ${String(opts.maxChars)}) — split the PR`,
    };
  }

  const contextFiles = await gatherContext(deps.git, files, opts.maxChars);

  return {
    kind: "request",
    request: {
      title: intent.slice(0, 80),
      intent,
      diff,
      validateSummary,
      contextFiles,
      rubricVersion: RUBRIC_VERSION,
    },
  };
}

/** The model reviewers get only the diff, so they can't see the surrounding code
 *  a hunk lives in — the difference between "proofreading a patch" and "reviewing
 *  against the codebase". Attach the FULL current (HEAD) contents of the changed
 *  files, bounded by a budget; whatever doesn't fit is reported, never silently
 *  dropped. (Agentic binary reviewers like codex can read further on their own.) */
async function gatherContext(
  git: IGatherDeps["git"],
  files: string[],
  budget: number
): Promise<string[]> {
  const blocks: string[] = [];
  let used = 0;
  let omitted = 0;

  for (const file of files) {
    const res = await git(["show", `HEAD:${file}`]);

    if (res.code !== 0) {
      continue; // deleted/renamed/binary — not readable at HEAD, skip
    }

    const block = `=== ${file} ===\n${res.stdout}`;

    if (used + block.length > budget) {
      omitted += 1;
      continue;
    }

    used += block.length;
    blocks.push(block);
  }

  if (omitted > 0) {
    blocks.push(
      `[${String(omitted)} changed file(s) omitted from context to fit the budget — review their diffs above directly]`
    );
  }

  return blocks;
}

export interface IRunDeps extends IGatherDeps, IInvokeDeps {
  panel: IPanel;
  identity: string;
}

function blockedVerdict(reason: string, identity: string): IVerdict {
  return {
    blocked: true,
    reason,
    reviewers: { ok: 0, errored: 0 },
    ranked: [],
    perReviewer: [],
    identity,
    // Pre-review gate/precondition block — the panel did not run. Marked so the
    // caller never caches it (a transient validate flake must not poison the
    // tree-hash and block every later push).
    preReview: true,
  };
}

export async function runHarnessReview(
  deps: IRunDeps,
  opts: IGatherOptions
): Promise<IVerdict> {
  const gathered = await gatherChange(deps, opts);

  if (gathered.kind === "block") {
    return blockedVerdict(gathered.reason, deps.identity);
  }

  const outcomes = await reviewerInvoke(deps.panel, gathered.request, {
    makeProvider: deps.makeProvider,
    runBinary: deps.runBinary,
  });

  return aggregate(outcomes, {
    minReviewers: deps.panel.minReviewers,
    identity: deps.identity,
  });
}

/** Verdict-cache schema version. Bump to invalidate ALL previously written cache
 *  artifacts in one shot. Bumped to "2" when pre-review gate blocks stopped being
 *  cached: legacy "1" artifacts can hold a poisoned "validate failed" block with no
 *  `preReview` marker, and without a version change readCachedVerdict would keep
 *  serving them and block every push of that tree. */
export const CACHE_VERSION = "2";

export function verdictCacheKey(input: {
  /** sha256 of the ACTUAL reviewed diff (`${base}...HEAD`, three-dot). This is what the
   *  reviewers see, so it captures the true merge-base: a moved base ref, a rebase that
   *  shifts the merge-base, or any tree change all produce a different diff → a different
   *  key. (Keying on a base SHA alone cannot — a rebase moves the merge-base with the ref
   *  and tree unchanged.) */
  diffHash: string;
  panelHash: string;
  rubricVersion: string;
  cacheVersion: string;
  /** The resolved review intent (commit subject when the flag is omitted) — different
   *  context ⇒ a different review; an amend that changes the subject changes this. */
  intent: string;
  /** "quick" | "full". `quick` reviews with a REDUCED roster (1 reviewer); its verdict
   *  must never satisfy a full review, and vice versa. */
  mode: string;
}): string {
  // JSON-serialize the fields (unforgeable: escapes + array delimiting) rather than a
  // space-join — a value containing a space (e.g. an intent string) could otherwise slide
  // across the boundary and forge a key collision, reusing a verdict for a different
  // request. Same lesson as the db:push fingerprint.
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.diffHash,
        input.panelHash,
        input.rubricVersion,
        input.cacheVersion,
        input.intent,
        input.mode,
      ])
    )
    .digest("hex");
}

export interface IReviewPlan {
  /** Cache key, or null when the diff was unfingerprintable (git failed) — a null key means
   *  the caller must NEITHER read nor write the cache (no sound key exists). */
  cacheKey: string | null;
  /** Base to hand `runHarnessReview` — identical to the base the cache key's diff was taken
   *  against, so the review reads exactly the diff the key fingerprinted. */
  reviewBase: string;
  /** Intent to hand `runHarnessReview` — the same resolved intent the key used. */
  reviewIntent: string | undefined;
}

/**
 * Bind the resolved review inputs to BOTH the cache key and the review request from a
 * SINGLE source, so the diff the key fingerprints and the diff the review reads can never
 * diverge. This closes the CI-parity hole the panel found: previously the `--ci` path
 * reviewed the raw flags while the key was built from the resolved values, so a verdict
 * could be stored under one request's key for another request's diff. Now both paths take
 * `reviewBase`/`reviewIntent` from here (the `--ci` path simply never reads the cache).
 * Pure and injectable so this wiring is unit-tested without spawning the CLI.
 */
export function reviewPlan(
  resolved: IResolvedReviewInputs,
  opts: { quick: boolean; panelHash: string }
): IReviewPlan {
  const cacheKey =
    resolved.diffHash === null
      ? null
      : verdictCacheKey({
          diffHash: resolved.diffHash,
          panelHash: opts.panelHash,
          rubricVersion: RUBRIC_VERSION,
          cacheVersion: CACHE_VERSION,
          intent: resolved.intent ?? "",
          mode: opts.quick ? "quick" : "full",
        });

  return {
    cacheKey,
    reviewBase: resolved.base,
    reviewIntent: resolved.intent ?? undefined,
  };
}

/** The caching decision, isolated so it is unit-testable without the filesystem.
 *  ONLY a real panel verdict is cached. A pre-review gate/precondition block
 *  (validate failed, empty intent, diff too large) is transient — caching one
 *  poisons the tree-hash so a flaky validate under load blocks every later push. */
export function shouldCacheVerdict(verdict: IVerdict): boolean {
  return verdict.preReview !== true;
}

/** The read-side guard, isolated for testing: a cached pre-review gate block must
 *  never be honored (defense in depth beside the CACHE_VERSION bump — belt and
 *  suspenders for any pre-review artifact that reaches disk). Returns the verdict
 *  to use, or null to force a fresh live review. */
export function honorCachedVerdict(verdict: IVerdict | null): IVerdict | null {
  return verdict !== null && verdict.preReview === true ? null : verdict;
}

export function artifactBody(
  v: IVerdict,
  meta: { treeHash: string; panelHash: string; when: string }
): string {
  return `${JSON.stringify({ when: meta.when, treeHash: meta.treeHash, panelHash: meta.panelHash, verdict: v }, null, 2)}\n`;
}
