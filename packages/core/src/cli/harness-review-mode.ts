import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isRecord } from "../lib/guards";
import { OpenAICompatibleProvider, type IProvider } from "../inference";
import {
  loadModelsConfig,
  resolveActiveModel,
  resolveApiKey,
  type IModelEntry,
  type BinaryInputMode,
} from "../models-config";
import { resolvePanel, type IPanel } from "../reviewers/registry";
import {
  gatherChange,
  reviewRequest,
  runReviewFlow,
  panelIdentityHash,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_CHARS,
  artifactBody,
  shouldCacheVerdict,
  honorCachedVerdict,
  type IReviewFlowDeps,
  type IReviewDeps,
  type IGitRunner,
  type IValidateRunner,
} from "../reviewers/harness-review";
import { type IValidateSummary } from "../reviewers/schema";
import { parseVerdict, type IVerdict } from "../reviewers/aggregate";

interface IArgs {
  base: string | undefined;
  intent: string | undefined;
  quick: boolean;
  ci: boolean;
  installHook: boolean;
}

function parse(argv: string[]): IArgs {
  const out: IArgs = {
    base: undefined,
    intent: undefined,
    quick: false,
    ci: false,
    installHook: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];

    if (a === "--quick") {
      out.quick = true;
    } else if (a === "--ci") {
      out.ci = true;
    } else if (a === "--install-hook") {
      out.installHook = true;
    } else if (a === "--intent") {
      i += 1;
      out.intent = argv[i];
    } else if (a === "--base") {
      i += 1;
      out.base = argv[i];
    }
  }

  return out;
}

function providerConfig(
  entry: IModelEntry
): ConstructorParameters<typeof OpenAICompatibleProvider>[0] {
  return {
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: resolveApiKey(entry),
    ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
    ...(entry.extraHeaders === undefined
      ? {}
      : { extraHeaders: entry.extraHeaders }),
    ...(entry.extraBody === undefined ? {} : { extraBody: entry.extraBody }),
  };
}

export function makeProvider(entry: IModelEntry): IProvider {
  return new OpenAICompatibleProvider(providerConfig(entry));
}

export interface IBinaryInvocation {
  cmd: string[];
  stdinBytes: Uint8Array | undefined;
  tmpFile: string | undefined;
}

export function buildBinaryInvocation(
  r: { argv: string[]; input: BinaryInputMode },
  stdin: string,
  tmpPath: string | undefined
): IBinaryInvocation {
  if (r.input === "arg") {
    return {
      cmd: [...r.argv, stdin],
      stdinBytes: undefined,
      tmpFile: undefined,
    };
  }

  if (r.input === "stdin") {
    return {
      cmd: [...r.argv],
      stdinBytes: new TextEncoder().encode(stdin),
      tmpFile: undefined,
    };
  }

  if (tmpPath === undefined) {
    throw new Error("tempfile mode requires a valid tmpPath");
  }

  return {
    cmd: [...r.argv, tmpPath],
    stdinBytes: undefined,
    tmpFile: tmpPath,
  };
}

export async function runBinary(
  r: { argv: string[]; input: BinaryInputMode; timeoutMs: number },
  stdin: string
): Promise<{ ok: boolean; stdout: string }> {
  const tmpPath =
    r.input === "tempfile"
      ? join(tmpdir(), `tsforge-review-${randomUUID()}.txt`)
      : undefined;

  if (tmpPath !== undefined) {
    await writeFile(tmpPath, stdin, "utf-8");
  }

  // SANDBOX the reviewer's working directory. The binary reviewers (grok, codex) receive the diff
  // to review via stdin/tempfile — they never need the real repo as their CWD. But an AGENTIC
  // reviewer (codex "can read further on its own") will run shell/git in whatever CWD it inherits,
  // and if that's the repo root it mutates the live checkout: observed corruption included junk
  // `git commit -m init` fixtures (a.ts/discount.ts) written onto the working branch, `user` reset
  // to `t/t@t.t`, and `core.bare` flipped true — which then propagated into pushes. Spawning each
  // reviewer in a throwaway temp dir confines every side effect there; the real repo is untouchable.
  const sandbox = await mkdtemp(join(tmpdir(), "tsforge-review-sandbox-"));
  const invocation = buildBinaryInvocation(r, stdin, tmpPath);
  const proc = Bun.spawn(invocation.cmd, {
    cwd: sandbox,
    stdin: invocation.stdinBytes,
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => {
    proc.kill();
  }, r.timeoutMs);

  try {
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;

    return { ok: code === 0, stdout };
  } finally {
    clearTimeout(timer);

    if (tmpPath !== undefined) {
      await rm(tmpPath, { force: true });
    }

    await rm(sandbox, { recursive: true, force: true });
  }
}

async function gitRunner(
  args: string[]
): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;

  return { stdout, code };
}

/**
 * Map a `bun run validate` run (its combined stdout+stderr `text` and exit `code`) into the panel's
 * IValidateSummary. Pure + exported so the passed/errors mapping is unit-tested.
 *
 * On PASS (exit 0) the summary is EMPTY errors — regardless of the word "error" appearing in green
 * output ("0 errors", a test name like "…error handling…", a fixture string). The old code
 * substring-matched `/error/iu` unconditionally, so a passing validate carried spurious diagnostics
 * that (a) misled the block message and (b) polluted the verdict CACHE KEY (which includes the
 * summary), varying run-to-run on identical green diffs → the cache never hit and every panel re-ran
 * the full 4-model review. Only when validate actually FAILS (exit ≠ 0) do we extract error lines.
 */
export function summarizeValidateOutput(
  text: string,
  code: number
): IValidateSummary {
  if (code === 0) {
    return { passed: true, failCount: 0, firstErrors: [] };
  }

  const firstErrors = text
    .split("\n")
    .filter((l) => /error/iu.test(l))
    .slice(0, 20);

  return { passed: false, failCount: firstErrors.length, firstErrors };
}

async function validateRunner(): Promise<IValidateSummary> {
  const proc = Bun.spawn(["bun", "run", "validate"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = `${await new Response(proc.stdout).text()}\n${await new Response(proc.stderr).text()}`;
  const code = await proc.exited;

  return summarizeValidateOutput(text, code);
}

export const CACHE_DIR = join(".tsforge", "harness-review");

async function readCachedVerdict(
  cacheKey: string,
  dir = CACHE_DIR
): Promise<IVerdict | null> {
  try {
    const path = join(dir, `${cacheKey}.json`);
    const content = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(content);

    if (!isRecord(parsed) || !("verdict" in parsed)) {
      return null;
    }

    // honorCachedVerdict drops any cached pre-review gate block (defense in depth
    // beside the CACHE_VERSION bump) so a transient precondition never re-serves.
    return honorCachedVerdict(parseVerdict(parsed.verdict));
  } catch {
    return null;
  }
}

async function writeCachedVerdict(
  cacheKey: string,
  verdict: IVerdict,
  treeHash: string,
  panelHash: string,
  dir = CACHE_DIR
): Promise<void> {
  const path = join(dir, `${cacheKey}.json`);
  const body = artifactBody(verdict, {
    treeHash,
    panelHash,
    when: new Date().toISOString(),
  });

  await mkdir(dir, { recursive: true });
  await writeFile(path, body, "utf-8");
}

/** The persistence seam — the ACTUAL guard at the write path, exported so a test
 *  can prove (against a real dir) that a pre-review gate block writes NO artifact
 *  while a real panel verdict does. A pure `shouldCacheVerdict` test alone can't
 *  catch an omitted/inverted/bypassed guard here; both cache-write call sites in
 *  this file go through this one function. */
export async function persistVerdict(
  verdict: IVerdict,
  cacheKey: string,
  treeHash: string,
  panelHash: string,
  dir = CACHE_DIR
): Promise<void> {
  if (shouldCacheVerdict(verdict)) {
    await writeCachedVerdict(cacheKey, verdict, treeHash, panelHash, dir);
  }
}

export function formatVerdict(v: IVerdict): string {
  const head = v.blocked ? "BLOCK" : "PASS";
  const lines = [
    `harness-review: ${head} — ${v.reason}`,
    `reviewers ok: ${String(v.reviewers.ok)}  errored: ${String(v.reviewers.errored)}  (builder: ${v.identity})`,
  ];

  for (const f of v.ranked) {
    lines.push(
      `  [${f.severity}/${f.findingCode}] ${f.file ?? "?"} — ${f.issue} (agreement ${String(f.agreement)})`
    );
  }

  return lines.join("\n");
}

/**
 * Wire the resolved CLI pieces (full panel + quick flag, args, git/validate, providers, cache
 * seams) into the runReviewFlow deps — exported so the CLI's central wiring is unit-tested.
 * The EFFECTIVE roster is derived HERE (quick mode → a 1-reviewer slice), so the cache key's
 * rosterHash and the review both target that effective roster — a `quick` run can't reuse a
 * full-panel verdict, or vice versa. mode/ci come from the args; gather reads args.base/intent.
 * A miswire (cfg roster, hardcoded ci, wrong panel, un-sliced quick roster) is caught here.
 */
export function buildReviewFlowDeps(input: {
  panel: IPanel;
  identity: string;
  quick: boolean;
  ci: boolean;
  base: string | undefined;
  intent: string | undefined;
  git: IGitRunner;
  validate: IValidateRunner;
  makeProvider: IReviewDeps["makeProvider"];
  runBinary: IReviewDeps["runBinary"];
  readCache: (key: string) => Promise<IVerdict | null>;
  persistArtifact: (
    verdict: IVerdict,
    key: string,
    rosterHash: string
  ) => Promise<void>;
}): IReviewFlowDeps {
  // `quick` reviews with a REDUCED roster (the first reviewer only). The effective roster
  // feeds BOTH the cache key and the review, so its verdict never satisfies a full review.
  const effective: IPanel = input.quick
    ? { ...input.panel, reviewers: input.panel.reviewers.slice(0, 1) }
    : input.panel;
  const rosterHash = panelIdentityHash(effective, input.identity);

  return {
    gather: () =>
      gatherChange(
        { git: input.git, validate: input.validate },
        {
          base: input.base,
          intent: input.intent,
          maxFiles: DEFAULT_MAX_FILES,
          maxChars: DEFAULT_MAX_CHARS,
        }
      ),
    identity: input.identity,
    rosterHash,
    mode: input.quick ? "quick" : "full",
    ci: input.ci,
    readCache: input.readCache,
    review: (request) =>
      reviewRequest(request, {
        makeProvider: input.makeProvider,
        runBinary: input.runBinary,
        panel: effective,
        identity: input.identity,
      }),
    persist: (v, key) => input.persistArtifact(v, key, rosterHash),
  };
}

export async function harnessReviewMode(argv: string[]): Promise<number> {
  const args = parse(argv);

  if (args.installHook) {
    process.stdout.write(
      "Run: git config core.hooksPath .githooks (see .githooks/pre-push)\n"
    );

    return 0;
  }

  const cfg = await loadModelsConfig();
  const active = await resolveActiveModel();
  const panel = resolvePanel(cfg, active);

  for (const s of panel.skipped) {
    process.stdout.write(`skipped reviewer ${s.id}: ${s.reason}\n`);
  }

  const treeHashRes = await gitRunner(["write-tree"]);
  const treeHash = treeHashRes.stdout.trim();
  const identity = `${active.name}/${active.entry.model}`;

  // runReviewFlow enforces the wiring invariant: GATHER (validate runs fresh inside) BEFORE
  // any cache access, and a gather block never touches the cache. The gathered request is
  // keyed from its OWN bytes, so key and review can't diverge. --ci writes but never reads.
  // buildReviewFlowDeps derives the EFFECTIVE roster (quick-slice) and the roster hash, and is
  // unit-tested for that wiring.
  const { verdict, cacheHit } = await runReviewFlow(
    buildReviewFlowDeps({
      panel,
      identity,
      quick: args.quick,
      ci: args.ci,
      base: args.base,
      intent: args.intent,
      git: gitRunner,
      validate: validateRunner,
      makeProvider,
      runBinary,
      readCache: readCachedVerdict,
      persistArtifact: (v, key, rosterHash) =>
        persistVerdict(v, key, treeHash, rosterHash),
    })
  );

  if (cacheHit) {
    process.stdout.write("harness-review: cache hit, reusing verdict\n");
  }

  process.stdout.write(`${formatVerdict(verdict)}\n`);

  return verdict.blocked ? 1 : 0;
}
