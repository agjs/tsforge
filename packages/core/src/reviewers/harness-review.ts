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

/**
 * Resolve the review's base and intent to their CONCRETE values — what the diff is
 * actually taken against and the actual intent text — so the verdict cache can key on
 * them. Keying on the raw flags is unsound: an omitted `--base` resolves to
 * `merge-base main HEAD` and a named ref like `main` is resolved at review time, so the
 * SAME flags can denote a DIFFERENT diff after `main` moves or a rebase; an omitted
 * `--intent` comes from the commit subject, which an amend changes — all with an
 * unchanged treeHash. Resolving the base to a SHA (via rev-parse) and the intent to its
 * text makes the cache key reflect the real review inputs, so those cases MISS the cache.
 * The same resolved values are then handed to the review, so the key and the review can
 * never diverge.
 */
export async function resolveReviewInputs(
  git: IGitRunner,
  base: string | undefined,
  intent: string | undefined
): Promise<{ baseSha: string; intent: string | null }> {
  const baseRef = await resolveBase(git, base);
  const revParsed = (await git(["rev-parse", baseRef])).stdout.trim();

  return {
    baseSha: revParsed.length > 0 ? revParsed : baseRef,
    intent: await resolveIntent(git, intent),
  };
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
  treeHash: string;
  panelHash: string;
  rubricVersion: string;
  cacheVersion: string;
  /** The diff base ref — a review vs a DIFFERENT base is a different diff, so it must
   *  not reuse this verdict. */
  base: string;
  /** The review intent — different context ⇒ a different review. */
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
        input.treeHash,
        input.panelHash,
        input.rubricVersion,
        input.cacheVersion,
        input.base,
        input.intent,
        input.mode,
      ])
    )
    .digest("hex");
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
