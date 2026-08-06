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

/** After a kill is signalled, how long to wait for the process to actually be
 *  reaped before giving up. NOT a SIGTERM grace — the kill is SIGKILL, which is
 *  not refusable — this covers a child that escaped its group (called `setsid`,
 *  say) and so survives the group kill. Without the bound, `proc.exited` might
 *  never resolve and the panel would wait forever. */
const KILL_GRACE_MS = 2_000;
/** Conventional exit code for a process terminated by SIGKILL (128 + 9). */
const SIGKILL_EXIT = 137;
/**
 * How long to keep draining stdout after the process itself has gone.
 *
 * A descendant inherits the pipe, so `Response.text()` waits for EOF — which
 * means the LAST child, not the reviewer. That hangs the panel whether the
 * reviewer was killed or exited cleanly on its own, so the bound is tied to the
 * process exiting rather than to the kill.
 */
const POST_EXIT_DRAIN_MS = 2_000;

/**
 * Hard ceiling on a reviewer's stdout. A review is a small JSON object; anything
 * past this is a runaway, and reading it to EOF would let one noisy reviewer
 * exhaust the harness.
 */
export const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/** What running a reviewer binary produced. */
export interface IBinaryRun {
  ok: boolean;
  stdout: string;
  timedOut: boolean;
  truncated: boolean;
  /** WHY the read ended, forwarded rather than collapsed. `truncated` alone
   *  cannot tell a flood from a pipe still open after the process went, and the
   *  two point at different problems — so a caller reporting the failure needs
   *  the distinction that readBounded already computed. */
  stoppedBy: IBoundedRead["stoppedBy"];
}

/** Mutable read state, held in an object so a closure can flip it. */
interface IReadState {
  expired: boolean;
  /** Set once the read has finished and cleaned up, so a late deadline callback
   *  does not arm a timer with nobody left to clear it. */
  done: boolean;
  stoppedBy: IBoundedRead["stoppedBy"];
}

/** What a bounded read produced, and why it stopped. */
interface IBoundedRead {
  text: string;
  /** `size` — the reviewer flooded us past the ceiling. `deadline` — the pipe
   *  was still open when the post-exit grace ran out. `eof` — the normal end. */
  stoppedBy: "eof" | "size" | "deadline";
  /** True whenever the read did not reach EOF.
   *
   *  Deliberately blunt. Whether an orphan holding the pipe is idle or still
   *  writing cannot be decided from here: a writer slower than the grace window
   *  looks exactly like a writer that has finished, and a heuristic on "did
   *  bytes arrive during the grace" only catches the loud half. Not reaching EOF
   *  means we cannot claim the answer is complete, so we do not.
   *
   *  The cost is a reviewer that backgrounds work having its review refused —
   *  visibly, with cause `truncated`, which is the whole point of these
   *  diagnostics. The alternative is passing a prefix off as a finished review,
   *  and a wrong verdict is worse than a missing one. */
  truncated: boolean;
}

/**
 * Read a stream to EOF, or stop shortly after the process is gone — keeping
 * whatever arrived, and saying whether anything was probably lost.
 *
 * Bounded by a FLAG, not by racing the deadline each iteration. `Promise.race`
 * resolves with the first ALREADY-SETTLED entry in array order, so once a
 * descendant keeps the pipe permanently readable, `reader.read()` wins every
 * round forever and the deadline never gets a turn — the bound silently stops
 * bounding for exactly the noisy-child case it exists to handle.
 *
 * Chunk by chunk, because racing a whole `Response.text()` throws away
 * everything already read the moment it gives up: a reviewer that answered and
 * exited, leaving a background child holding the pipe, would lose a complete
 * answer for the sake of the child.
 */
export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  gone: Promise<unknown>
): Promise<IBoundedRead> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const state: IReadState = { expired: false, done: false, stoppedBy: "eof" };
  let bytes = 0;
  let text = "";

  // A clearable timer, not Bun.sleep: an un-cancellable sleep starts on EVERY
  // run the moment the process exits and keeps the event loop alive for its full
  // grace, healthy reviewers included.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = gone.then(
    () =>
      new Promise<void>((resolve) => {
        // The read can finish before the process does — EOF on a reviewer that
        // is still shutting down — and this callback then runs AFTER cleanup,
        // arming a timer nothing will ever clear and holding the event loop open
        // past every healthy run. That is the uncancellable tail all over again,
        // just reached from the other side.
        if (state.done) {
          resolve();

          return;
        }

        graceTimer = setTimeout(() => {
          state.expired = true;
          resolve();
        }, POST_EXIT_DRAIN_MS);
      })
  );

  try {
    for (;;) {
      if (state.expired) {
        state.stoppedBy = "deadline";
        break;
      }

      const next = await Promise.race([reader.read(), deadline]);

      // `deadline` resolves to undefined; the flag above ends the loop on the
      // next pass, so this only skips one iteration.
      if (next === undefined) {
        continue;
      }

      if (next.done) {
        break;
      }

      // The ceiling is checked AFTER the read, not before. Breaking on a full
      // buffer first would call a stream of exactly MAX_STDOUT_BYTES truncated,
      // though its next read is EOF and nothing was lost — the documented
      // runaway condition is output PAST the ceiling.
      const room = MAX_STDOUT_BYTES - bytes;

      if (next.value.length > room) {
        // Sliced to the remaining allowance: appending whole and checking
        // afterwards lets the text overrun by a full chunk, which for a reviewer
        // emitting megabyte chunks is not a rounding error.
        bytes += room;
        text += decoder.decode(next.value.subarray(0, room), { stream: true });
        state.stoppedBy = "size";
        break;
      }

      bytes += next.value.length;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    state.done = true;
    clearTimeout(graceTimer);
    await reader.cancel().catch(() => undefined);
  }

  return {
    text: text + decoder.decode(),
    stoppedBy: state.stoppedBy,
    truncated: state.stoppedBy !== "eof",
  };
}

export async function runBinary(
  r: { argv: string[]; input: BinaryInputMode; timeoutMs: number },
  stdin: string
): Promise<IBinaryRun> {
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
  // `detached: true` makes the reviewer its OWN process-group leader, so the
  // kill below takes down the whole group — the `sh -c` wrapper AND anything it
  // backgrounded. This is how lib/fs/process.ts already does it, and it is the
  // portable way to get a new group (setsid is not on macOS).
  //
  // An earlier version of this walked the tree with `pgrep` instead, on the
  // stated premise that Bun.spawn could not create a group. That was simply
  // false — the pattern was already in this repo — and the walk could not work
  // anyway: SIGTERM makes a well-behaved parent exit, its TERM-ignoring child is
  // re-parented to init, and there is nothing left to walk from.
  const proc = Bun.spawn(invocation.cmd, {
    cwd: sandbox,
    stdin: invocation.stdinBytes,
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  // Recorded rather than inferred: a killed process exits non-zero, so the exit
  // code alone cannot distinguish "we killed it at the budget" from "it failed
  // on its own". Only the killer knows.
  // In an object for the same reason as the read state below: the timer flips
  // this from a callback, and control-flow analysis cannot see that.
  const kill = { timedOut: false };
  const timer = setTimeout(() => {
    kill.timedOut = true;
    killGroup();
  }, r.timeoutMs);
  // NOTE: the trigger for this cannot be reproduced portably from a test — a
  // process that survives SIGKILL means one that left its group (setsid, a
  // re-exec), and there is no shell-level way to arrange that on both macOS and
  // Linux. What IS tested is the mechanism it depends on: readBounded abandons a
  // stream that never ends once the promise it was given settles.
  //
  // Resolves only once a kill has been signalled AND the process still has not
  // been reaped a grace later — i.e. it escaped its group and survived SIGKILL.
  // Raced against `proc.exited` so the wait below always settles; without it an
  // un-reapable reviewer wedges the panel forever. Same shape as process.ts.
  let resolveEscaped: (() => void) | null = null;
  const escaped = new Promise<void>((resolve) => {
    resolveEscaped = resolve;
  });
  const escape: { timer: ReturnType<typeof setTimeout> | null } = {
    timer: null,
  };

  /**
   * Kill the whole group, falling back to the lone child when the group is gone
   * (ESRCH) or not permitted (EPERM). Never throws.
   *
   * SIGKILL directly rather than SIGTERM-then-escalate: the budget has already
   * expired by the time this runs, and a reviewer that asked for more time by
   * ignoring SIGTERM is the case the budget exists for.
   */
  const killGroup = (): void => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill(9);
      } catch {
        // Already exited.
      }
    }

    escape.timer ??= setTimeout(() => resolveEscaped?.(), KILL_GRACE_MS);
  };

  try {
    // Cleared the MOMENT the process exits, not after stdout finishes draining.
    // A reviewer can finish under budget while its output is still being read
    // (a big review, a descendant holding the pipe), and a timer firing during
    // that drain would mark a completed review as timed out and throw its answer
    // away — the exact false signal this change exists to remove, and likeliest
    // near the budget edge under concurrent panel load.
    const exited = proc.exited.then((code) => {
      clearTimeout(timer);

      return code;
    });
    // Bounded by EITHER the process exiting or the escape hatch firing. Hanging
    // the drain off `exited` alone deadlocks the case the escape hatch exists
    // for: a process that survives SIGKILL never settles `exited`, so the
    // post-exit grace never starts, the read loops forever, and execution never
    // reaches the race below at all.
    const settled = Promise.race([exited, escaped]);
    const read = await readBounded(proc.stdout, settled);

    // A reviewer that floods and KEEPS RUNNING would otherwise hold the panel
    // until its full budget — we stopped reading, but nothing stopped it — and
    // the budget timer would then fire, so a runaway stdout got reported as a
    // timeout and pointed the operator at the wrong knob. Once the ceiling is
    // hit there is nothing left to wait for.
    if (read.stoppedBy === "size") {
      clearTimeout(timer);
      killGroup();
    }

    // Raced, so a process that outlived SIGKILL cannot hold the panel.
    const code = await Promise.race([exited, escaped.then(() => SIGKILL_EXIT)]);

    return {
      ok: code === 0 && !kill.timedOut && !read.truncated,
      stdout: read.text,
      // A size stop kills the process itself, so a budget timer that fires
      // afterwards is describing our own kill, not an over-budget reviewer.
      timedOut: kill.timedOut && read.stoppedBy !== "size",
      truncated: read.truncated,
      stoppedBy: read.stoppedBy,
    };
  } finally {
    clearTimeout(timer);
    // Every reviewer, not only the ones that misbehaved: a reviewer that exits
    // cleanly can still leave a backgrounded child holding resources, and
    // killing an already-empty group costs nothing.
    killGroup();
    clearTimeout(escape.timer ?? undefined);

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

/**
 * Flatten untrusted text to a single printable line.
 *
 * Reviewer ids and error strings reach the terminal verbatim, and neither is
 * ours: an error message can carry a remote provider's response body, and a
 * cached verdict is read back off disk. An embedded newline forges an extra
 * verdict line — `! x did not review` followed by a fabricated `harness-review:
 * PASS` — and an escape sequence can rewrite what a CI log appears to say.
 * Neither belongs in a summary someone reads to decide whether to merge.
 */
function oneLine(value: string): string {
  let out = "";

  // A code-point walk: a control-character regex is disallowed here, and
  // spread/split on a string mishandles astral characters.
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 (newline and ESC among them), DEL, C1 — plus the Unicode line/paragraph
    // separators, which a terminal breaks on exactly like a newline, and the
    // bidi overrides, which can visually reorder a line into something it does
    // not say.
    const control =
      code < 0x20 ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x2066 && code <= 0x2069);

    out += control ? " " : ch;
  }

  const flattened = out.trim();

  return flattened.length > MAX_FAILURE_TEXT
    ? `${flattened.slice(0, MAX_FAILURE_TEXT)}…`
    : flattened;
}

/** Enough for a real message, short of letting a reviewer paste a novel into the
 *  summary. */
const MAX_FAILURE_TEXT = 300;

export function formatVerdict(v: IVerdict): string {
  const head = v.blocked ? "BLOCK" : "PASS";
  const lines = [
    // The reason can be derived straight from a reviewer-controlled finding, so
    // it is no more ours than the failure text below it.
    `harness-review: ${head} — ${oneLine(v.reason)}`,
    `reviewers ok: ${String(v.reviewers.ok)}  errored: ${String(v.reviewers.errored)}  (builder: ${oneLine(v.identity)})`,
  ];

  // Name every reviewer that dropped out, with why and how long it took. A bare
  // "errored: 2" is the same line whether two binaries are misconfigured or the
  // whole panel timed out, and those need opposite responses.
  const failures = v.failures ?? [];

  for (const f of failures) {
    const took =
      f.ms === undefined ? "" : ` after ${(f.ms / 1000).toFixed(1)}s`;

    lines.push(
      `  ! ${oneLine(f.reviewerId)} did not review (${f.cause ?? "error"})${took}: ${oneLine(f.error)}`
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
      `  [${f.severity}/${f.findingCode}] ${oneLine(f.file ?? "?")} — ${oneLine(f.issue)} (agreement ${String(f.agreement)})`
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

  // A panel that failed to parse is dropped by the loader so the rest of the
  // registry still works — but a REVIEW cannot proceed without one, and silently
  // running with zero reviewers would report "insufficient reviewers" and point
  // at the endpoint instead of the typo.
  if (cfg.reviewPanelError !== undefined) {
    process.stdout.write(
      `harness-review: review panel is unusable — ${oneLine(cfg.reviewPanelError)}\n`
    );

    return 1;
  }

  const active = await resolveActiveModel();
  const panel = resolvePanel(cfg, active);

  for (const s of panel.skipped) {
    // Config-derived, so no more ours than a reviewer's own output.
    process.stdout.write(
      `skipped reviewer ${oneLine(s.id)}: ${oneLine(s.reason)}\n`
    );
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
