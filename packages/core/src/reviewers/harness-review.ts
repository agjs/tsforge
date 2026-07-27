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
  const ref = explicit !== undefined && explicit.length > 0 ? explicit : "main";
  // Pin to the merge-base SHA, not the ref. The diff is `${base}...HEAD` (three-dot), whose
  // true origin is merge-base(ref, HEAD); returning that immutable SHA means the bytes the
  // fingerprint hashes and the bytes the review diffs are ONE snapshot even if `ref` moves
  // between the two in-process git calls (and a rebase that shifts the merge-base changes it).
  const res = await git(["merge-base", ref, "HEAD"]);
  const base = res.stdout.trim();

  if (base.length > 0) {
    return base;
  }

  // merge-base failed (e.g. no `main`): fall back to the ref itself (or HEAD~1 when omitted).
  // Cache safety does not rest on this — an unresolvable diff yields diffHash=null downstream.
  return explicit !== undefined && explicit.length > 0 ? explicit : "HEAD~1";
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

  // Read the changed-file list AND check git's exit code. Ignoring it lets a failed diff
  // (empty stdout on error) build an EMPTY review that the panel green-lights, then caches
  // under the real request's key — a false green. A failure blocks instead.
  const namesRes = await deps.git(["diff", "--name-only", `${base}...HEAD`]);

  if (namesRes.code !== 0) {
    return {
      kind: "block",
      reason: `could not compute the changed-file list (git diff exited ${String(namesRes.code)}) — cannot review`,
    };
  }

  const files = namesRes.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (files.length === 0) {
    return {
      kind: "block",
      reason: `no changes between ${base} and HEAD to review`,
    };
  }

  if (files.length > opts.maxFiles) {
    return {
      kind: "block",
      reason: `diff too large (${String(files.length)} files > ${String(opts.maxFiles)}) — split the PR`,
    };
  }

  const diffRes = await deps.git(["diff", `${base}...HEAD`]);

  if (diffRes.code !== 0) {
    return {
      kind: "block",
      reason: `could not compute the diff (git diff exited ${String(diffRes.code)}) — cannot review`,
    };
  }

  const diff = diffRes.stdout;

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

/** A pre-review gate/precondition block (validate red, empty intent, diff too large,
 *  git failure). The panel did NOT run. Marked `preReview` so it is never cached — a
 *  transient block must not poison the cache and reject every later push. Exported so the
 *  CLI produces it directly (it gathers the request itself, then reviews). */
export function blockedVerdict(reason: string, identity: string): IVerdict {
  return {
    blocked: true,
    reason,
    reviewers: { ok: 0, errored: 0 },
    ranked: [],
    perReviewer: [],
    identity,
    preReview: true,
  };
}

export interface IReviewDeps extends IInvokeDeps {
  panel: IPanel;
  identity: string;
}

/** Run the panel on an ALREADY-GATHERED request (validate + diff + context already built).
 *  Split out from runHarnessReview so the CLI can fingerprint the exact request for the
 *  cache key BEFORE deciding whether to invoke the models — key and review then hash the
 *  same bytes by construction. */
export async function reviewRequest(
  request: IReviewRequest,
  deps: IReviewDeps
): Promise<IVerdict> {
  const outcomes = await reviewerInvoke(deps.panel, request, {
    makeProvider: deps.makeProvider,
    runBinary: deps.runBinary,
  });

  return aggregate(outcomes, {
    minReviewers: deps.panel.minReviewers,
    identity: deps.identity,
  });
}

export async function runHarnessReview(
  deps: IRunDeps,
  opts: IGatherOptions
): Promise<IVerdict> {
  const gathered = await gatherChange(deps, opts);

  if (gathered.kind === "block") {
    return blockedVerdict(gathered.reason, deps.identity);
  }

  return reviewRequest(gathered.request, deps);
}

/** Verdict-cache schema version. Bump to invalidate ALL previously written cache
 *  artifacts in one shot. Bumped to "3" when the key changed from a diff-hash to a full
 *  request fingerprint (below): legacy artifacts key on incomparable inputs, so the bump
 *  retires them rather than risk a stale-input collision. */
export const CACHE_VERSION = "3";

/**
 * Fingerprint the EXACT review request the reviewers will judge — the diff AND the full
 * `contextFiles` (the changed files' HEAD contents) AND the intent AND the rubric — plus
 * the roster identity and mode. This is the cache key.
 *
 * Keying on a diff hash alone is unsound: reviewers also see `contextFiles`, so a rebase
 * onto a different base can yield identical patch bytes while the surrounding file contents
 * (and thus the review input) differ — a false reuse. Hashing the request object itself,
 * the same object handed to `reviewRequest`, makes the key and the review provably one
 * input: there is no second git read to diverge from.
 */
export function reviewRequestKey(
  request: IReviewRequest,
  opts: { rosterHash: string; mode: string }
): string {
  // JSON array (unforgeable: escaped + delimited) over the reviewer-visible content. The
  // validate summary is NOT keyed — validate is re-run fresh every invocation (a request
  // only exists when it currently passes), so it is a live precondition, not a cache axis.
  return createHash("sha256")
    .update(
      JSON.stringify([
        request.diff,
        request.contextFiles ?? [],
        request.intent,
        request.rubricVersion,
        opts.rosterHash,
        opts.mode,
        CACHE_VERSION,
      ])
    )
    .digest("hex");
}

/**
 * Identity of the roster that ACTUALLY reviewed — the resolved reviewer ids (after skips,
 * quick-slicing, and active-model exclusion), the quorum, and the builder. A verdict from a
 * different roster (a reviewer added/dropped, a different builder whose independence differs)
 * must not be reused, so this feeds the cache key. Keying on the raw config instead would
 * miss all of those, which the panel flagged.
 */
export function panelIdentityHash(
  panel: { reviewers: readonly { id: string }[]; minReviewers: number },
  builderIdentity: string
): string {
  const roster = panel.reviewers.map((r) => r.id).sort();

  return createHash("sha256")
    .update(JSON.stringify([roster, panel.minReviewers, builderIdentity]))
    .digest("hex");
}

export interface IDecideDeps {
  /** Read a cached verdict by key (already applies the pre-review guard); null = miss. */
  readCache: (key: string) => Promise<IVerdict | null>;
  /** Run the live panel (only reached on a miss or --ci). */
  review: () => Promise<IVerdict>;
  /** Persist the verdict under the key (the real impl guards against caching a pre-review block). */
  persist: (verdict: IVerdict, key: string) => Promise<void>;
}

/**
 * Decide a verdict for an already-gathered, already-keyed request: reuse the cache when
 * possible, else run the panel and persist. Extracted from the CLI so the wiring is
 * unit-testable (the panel required proof that a cache hit is reused, a miss writes under
 * the key, and --ci writes but never reads).
 *
 * Validate freshness is NOT this function's concern: the caller gathers the request first
 * (gatherChange runs validate fresh and blocks — never reaching here — when the gate is red),
 * so a cache hit implies the gate currently passes. --ci never READS the cache (CI always
 * re-reviews) but still WRITES it, seeding a later interactive run with the identical request.
 */
export async function decideVerdict(
  deps: IDecideDeps,
  opts: { ci: boolean; key: string }
): Promise<{ verdict: IVerdict; cacheHit: boolean }> {
  if (!opts.ci) {
    const cached = await deps.readCache(opts.key);

    if (cached !== null) {
      return { verdict: cached, cacheHit: true };
    }
  }

  const verdict = await deps.review();

  await deps.persist(verdict, opts.key);

  return { verdict, cacheHit: false };
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
