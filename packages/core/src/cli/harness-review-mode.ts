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

/** How long a reviewer gets to honour SIGTERM before SIGKILL. Long enough for a
 *  normal shutdown, short enough that an unkillable reviewer cannot hold the
 *  panel. */
const KILL_GRACE_MS = 2_000;
/** How long to keep draining stdout AFTER a kill. A descendant can hold the pipe
 *  open long past the reviewer's own exit; the output is discarded on a timeout
 *  regardless, so waiting for EOF buys nothing. */
const POST_KILL_DRAIN_MS = 1_000;

/** Read a stream to EOF, but stop shortly after `killed()` turns true. */
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  killed: () => boolean
): Promise<string> {
  const text = new Response(stream).text();

  return await Promise.race([
    text,
    (async (): Promise<string> => {
      while (!killed()) {
        await Bun.sleep(50);
      }

      await Bun.sleep(POST_KILL_DRAIN_MS);

      return "";
    })(),
  ]);
}

export async function runBinary(
  r: { argv: string[]; input: BinaryInputMode; timeoutMs: number },
  stdin: string
): Promise<{ ok: boolean; stdout: string; timedOut: boolean }> {
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
  // Recorded rather than inferred: a killed process exits non-zero, so the exit
  // code alone cannot distinguish "we killed it at the budget" from "it failed
  // on its own". Only the killer knows.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
    // SIGTERM is a request. A reviewer that ignores it — or installs a handler
    // and takes its time — would otherwise keep the whole panel blocked past a
    // budget that exists precisely to stop that. SIGKILL is not refusable.
    killHard = setTimeout(() => {
      proc.kill(9);
    }, KILL_GRACE_MS);
  }, r.timeoutMs);
  let killHard: ReturnType<typeof setTimeout> | undefined;

  try {
    // Cleared the MOMENT the process exits, not after stdout finishes draining.
    // A reviewer can finish under budget while its output is still being read
    // (a big review, a busy event loop), and a timer firing during that drain
    // would mark a completed review as a timeout and throw its answer away —
    // the exact false signal this change exists to remove, and most likely near
    // the budget edge under concurrent panel load.
    const exited = proc.exited.then((code) => {
      clearTimeout(timer);

      return code;
    });
    // Bounded because a KILLED process can leave a descendant holding the
    // stdout pipe open (a backgrounded child inherits it), and reading to EOF
    // would then wait for that descendant rather than for the reviewer. On a
    // timeout the output is discarded anyway, so giving up on it is free.
    const stdout = await readBounded(proc.stdout, () => timedOut);
    const code = await exited;

    // A killed process is NOT a success, whatever it exited with. A binary can
    // trap SIGTERM and exit 0, which would otherwise report `ok: true,
    // timedOut: true` — and an over-budget reviewer's partial output would be
    // parsed and counted as a real review. Whatever it managed to print before
    // we killed it is a partial answer, and a partial answer is not a review.
    return { ok: code === 0 && !timedOut, stdout, timedOut };
  } finally {
    clearTimeout(timer);
    clearTimeout(killHard);

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

async function validateRunner(): Promise<{
  passed: boolean;
  failCount: number;
  firstErrors: string[];
}> {
  const proc = Bun.spawn(["bun", "run", "validate"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = `${await new Response(proc.stdout).text()}\n${await new Response(proc.stderr).text()}`;
  const code = await proc.exited;
  const firstErrors = text
    .split("\n")
    .filter((l) => /error/iu.test(l))
    .slice(0, 20);

  return { passed: code === 0, failCount: firstErrors.length, firstErrors };
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

    // honorCachedVerdict drops any cached pre-review gate block OR no-quorum
    // block (defense in depth beside the CACHE_VERSION bump) so neither a
    // transient precondition nor an endpoint outage ever re-serves.
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

  // Name every reviewer that dropped out, with why and how long it took. A bare
  // "errored: 2" is the same line whether two binaries are misconfigured or the
  // whole panel timed out, and those need opposite responses.
  const failures = v.failures ?? [];

  for (const f of failures) {
    const took =
      f.ms === undefined ? "" : ` after ${(f.ms / 1000).toFixed(1)}s`;

    lines.push(
      `  ! ${f.reviewerId} did not review (${f.cause ?? "error"})${took}: ${f.error}`
    );
  }

  // SAY when detail is missing rather than printing a shorter list that looks
  // complete. A cached artifact from an older build, or one whose entries did
  // not survive parsing, otherwise silently regresses to count-only — the state
  // this change exists to leave behind — with nothing to indicate it.
  const undetailed = v.reviewers.errored - failures.length;

  if (undetailed > 0) {
    lines.push(
      `  ! ${String(undetailed)} further reviewer failure(s) with no readable detail`
    );
  }

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
