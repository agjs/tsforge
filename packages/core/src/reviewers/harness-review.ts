import { createHash } from "node:crypto";
import type { IPanel, ResolvedReviewer } from "./registry";
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
  /** The commit to review (a SHA/ref). Defaults to HEAD. The pre-push hook passes the ACTUAL
   *  pushed local OID here, so an explicit refspec pushing a non-HEAD ref is reviewed as what
   *  is being pushed — not whatever HEAD happens to be. */
  head?: string;
  maxFiles: number;
  maxChars: number;
}

export type GatherResult =
  | { kind: "request"; request: IReviewRequest }
  | { kind: "block"; reason: string };

async function resolveBase(
  git: IGitRunner,
  explicit: string | undefined,
  head: string
): Promise<string> {
  const ref = explicit !== undefined && explicit.length > 0 ? explicit : "main";
  // Pin to the merge-base SHA against the PINNED head, not the ref. The diff is
  // `${base}...${head}` (three-dot), whose true origin is merge-base(ref, head); returning
  // that immutable SHA means the bytes the fingerprint hashes and the bytes the review diffs
  // are ONE snapshot even if `ref` moves (and a rebase that shifts the merge-base changes it).
  const res = await git(["merge-base", ref, head]);
  const base = res.stdout.trim();

  if (base.length > 0) {
    return base;
  }

  // merge-base failed (e.g. no `main`): fall back to the ref itself (or HEAD~1 when omitted).
  // Cache safety does not rest on this — if the resulting `${base}...${head}` diff can't be
  // computed, gatherChange blocks (git-exit / empty-diff guards) rather than caching a
  // vacuous review.
  return explicit !== undefined && explicit.length > 0 ? explicit : "HEAD~1";
}

async function resolveIntent(
  git: IGitRunner,
  explicit: string | undefined,
  head: string
): Promise<string | null> {
  if (explicit !== undefined && explicit.trim().length > 0) {
    return explicit.trim();
  }

  const subject = (await git(["log", "-1", "--format=%s", head])).stdout.trim();

  return GENERIC_INTENTS.has(subject.toLowerCase()) ? null : subject;
}

export async function gatherChange(
  deps: IGatherDeps,
  opts: IGatherOptions
): Promise<GatherResult> {
  // Pin the review target (opts.head, default HEAD) to an immutable SHA FIRST — before
  // validate and every diff — so the whole gather references one snapshot and validate's
  // result is attributed to a fixed commit. Guard the exit code like every other git step: a
  // failed pin BLOCKS (a soft fallback to the movable "HEAD" would silently re-open the
  // TOCTOU). (Validate still runs against the working tree; for the pre-push gate that tree is
  // the pinned commit — an unstaged divergence from it is the caller's responsibility.)
  const target = opts.head ?? "HEAD";
  const headRes = await deps.git(["rev-parse", target]);

  if (headRes.code !== 0) {
    return {
      kind: "block",
      reason: `could not resolve the review target (git rev-parse ${target} exited ${String(headRes.code)}) — cannot review`,
    };
  }

  const head =
    headRes.stdout.trim().length > 0 ? headRes.stdout.trim() : target;

  const validateSummary = await deps.validate();

  if (!validateSummary.passed) {
    return {
      kind: "block",
      reason: `validate failed (${String(validateSummary.failCount)} errors) — fix the gate before review:\n${validateSummary.firstErrors.join("\n")}`,
    };
  }

  const base = await resolveBase(deps.git, opts.base, head);
  const intent = await resolveIntent(deps.git, opts.intent, head);

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
  const namesRes = await deps.git(["diff", "--name-only", `${base}...${head}`]);

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
      reason: `no changes between ${base} and ${head} to review`,
    };
  }

  if (files.length > opts.maxFiles) {
    return {
      kind: "block",
      reason: `diff too large (${String(files.length)} files > ${String(opts.maxFiles)}) — split the PR`,
    };
  }

  const diffRes = await deps.git(["diff", `${base}...${head}`]);

  if (diffRes.code !== 0) {
    return {
      kind: "block",
      reason: `could not compute the diff (git diff exited ${String(diffRes.code)}) — cannot review`,
    };
  }

  const diff = diffRes.stdout;

  if (diff.length === 0) {
    // Defense in depth: files were listed but the CONTENT diff came back empty. (A real
    // rename/mode-only change is NOT empty — git emits `similarity index` / `old mode` etc.
    // — so this is an anomaly: a git quirk, or a `--name-only`/`diff` disagreement.) There is
    // nothing for the reviewers to judge, so block rather than build+cache a vacuous review.
    return {
      kind: "block",
      reason: `the diff between ${base} and ${head} is empty despite listed changes — nothing to review`,
    };
  }

  if (diff.length > opts.maxChars) {
    return {
      kind: "block",
      reason: `diff too large (${String(diff.length)} chars > ${String(opts.maxChars)}) — split the PR`,
    };
  }

  const contextFiles = await gatherContext(
    deps.git,
    files,
    head,
    opts.maxChars
  );

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
  head: string,
  budget: number
): Promise<string[]> {
  const blocks: string[] = [];
  let used = 0;
  let omitted = 0;

  for (const file of files) {
    const res = await git(["show", `${head}:${file}`]);

    if (res.code !== 0) {
      continue; // deleted/renamed/binary — not readable at this commit, skip
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

/** A pre-review gate/precondition block (validate red, empty intent, empty/oversized diff,
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
 *  Split from the gather step so the CLI can fingerprint the exact request for the cache
 *  key BEFORE deciding whether to invoke the models — key and review then hash the same
 *  bytes by construction. */
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

/** Verdict-cache schema version. Bump to invalidate ALL previously written cache
 *  artifacts in one shot. Bumped to "3" when the key changed from a diff-hash to a full
 *  request fingerprint (below): legacy artifacts key on incomparable inputs, so the bump
 *  retires them rather than risk a stale-input collision. */
export const CACHE_VERSION = "3";

/** Deterministic JSON: recursively sort object keys so equal CONTENT hashes equally
 *  regardless of construction/insertion order. A cache key must not thrash — or, if a
 *  second request-construction path ever appears, diverge — because two equal requests
 *  serialized their keys in a different order. Exported so the cache-key pin test can
 *  recompute the exact digest (and catch an accidental drop of CACHE_VERSION from the key). */
export function canonicalJson(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(canon);
    }

    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};

      for (const [k, val] of Object.entries(v).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      )) {
        out[k] = canon(val);
      }

      return out;
    }

    return v;
  };

  return JSON.stringify(canon(value));
}

/**
 * Fingerprint the EXACT review request the reviewers will judge, plus the roster identity
 * and mode. This is the cache key.
 *
 * It hashes the WHOLE `request` object — the same object handed to `reviewRequest` — not a
 * hand-picked subset. That makes key and review provably one input: any byte a reviewer
 * sees (diff, the full `contextFiles`, intent, rubricVersion, AND the `validateSummary`
 * including its `firstErrors`/`failCount`, which the panel reads) is in the key. Selecting a
 * subset was unsound — e.g. `validateRunner` can return `passed:true` with a non-empty
 * `firstErrors`, so two runs with an identical diff but different validate diagnostics feed
 * the reviewers different bytes; omitting the summary would false-reuse across them.
 * Serialized canonically (key-sorted) so equal content always yields the same digest.
 */
export function reviewRequestKey(
  request: IReviewRequest,
  opts: { rosterHash: string; mode: string }
): string {
  return createHash("sha256")
    .update(canonicalJson([request, opts.rosterHash, opts.mode, CACHE_VERSION]))
    .digest("hex");
}

/**
 * Identity of the roster that ACTUALLY reviewed. Hashes the FULL resolved reviewer objects
 * (kind, id, model `entry`, binary argv/input mode, endpoint, timeout — every field), not
 * just their ids: retargeting the SAME id to a different model/endpoint/binary yields a
 * different reviewer IMPLEMENTATION whose verdict must not be reused. Plus the quorum and
 * the builder identity (independence differs per builder). Sorted by id so resolution order
 * doesn't churn the key. This feeds the cache key; keying on ids alone (or the raw config)
 * missed reviewer-implementation changes, which the panel flagged.
 */
export function panelIdentityHash(
  panel: { reviewers: readonly ResolvedReviewer[]; minReviewers: number },
  builderIdentity: string
): string {
  const roster = [...panel.reviewers].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );

  return createHash("sha256")
    .update(canonicalJson([roster, panel.minReviewers, builderIdentity]))
    .digest("hex");
}

export interface IReviewFlowDeps {
  /** Gather the review request — runs validate FRESH and builds the request (or blocks). */
  gather: () => Promise<GatherResult>;
  identity: string;
  /** Fingerprint of the effective roster + builder (panelIdentityHash). */
  rosterHash: string;
  /** "quick" | "full". */
  mode: string;
  ci: boolean;
  /** Read a cached verdict by key (already applies the pre-review guard); null = miss. */
  readCache: (key: string) => Promise<IVerdict | null>;
  /** Run the live panel on the gathered request (only reached on a miss or --ci). */
  review: (request: IReviewRequest) => Promise<IVerdict>;
  /** Persist the verdict under the key (the real impl guards against caching a pre-review block). */
  persist: (verdict: IVerdict, key: string) => Promise<void>;
}

/**
 * The end-to-end review flow, injectable so the CLI wiring's CENTRAL INVARIANT is directly
 * testable rather than only implied by the units: the request is GATHERED (validate runs
 * inside gather) BEFORE any cache access, and a gather block (validate red / precondition)
 * yields a blocked verdict WITHOUT reading OR writing the cache. Only a gathered request is
 * keyed — from its own bytes — then reused-or-reviewed. A future reordering or bypass in the
 * CLI that read the cache before validating, or reused a verdict across a red gate, breaks a
 * test here (which unit tests for gather + the cache decision separately cannot catch).
 *
 * `--ci` never READS the cache (CI always re-reviews) but still WRITES it, seeding a later
 * interactive run with the identical request.
 */
export async function runReviewFlow(
  deps: IReviewFlowDeps
): Promise<{ verdict: IVerdict; cacheHit: boolean }> {
  const gathered = await deps.gather();

  if (gathered.kind === "block") {
    // Validate red / precondition — never touch the cache.
    return {
      verdict: blockedVerdict(gathered.reason, deps.identity),
      cacheHit: false,
    };
  }

  const key = reviewRequestKey(gathered.request, {
    rosterHash: deps.rosterHash,
    mode: deps.mode,
  });

  if (!deps.ci) {
    const cached = await deps.readCache(key);

    if (cached !== null) {
      return { verdict: cached, cacheHit: true };
    }
  }

  const verdict = await deps.review(gathered.request);

  await deps.persist(verdict, key);

  return { verdict, cacheHit: false };
}

/** The caching decision, isolated so it is unit-testable without the filesystem.
 *  ONLY a real panel verdict is cached. A pre-review gate/precondition block
 *  (validate failed, empty intent, empty/oversized diff) is transient — caching one
 *  would re-serve as a permanent block for that request, so it is skipped. */
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
