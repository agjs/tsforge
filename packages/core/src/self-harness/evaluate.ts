/**
 * EVALUATE (paper §3.1/§3.4): run a harness variant over corpus tasks and
 * score it. Drives the SAME implement path the eval sweep uses — parseSpec →
 * strict-floor gating (buildGate) → runSpec — with the variant's overlay
 * activated via TSFORGE_SELF_HARNESS_OVERLAY for the duration of the runs,
 * so the injection points resolve it exactly the way a real run would.
 *
 * Quality is a MEASUREMENT here (a single judge() call on green runs), never
 * sweep's qualityRepair improve-loop — an evaluator that edits the solution
 * would contaminate the very comparison the acceptance rule depends on.
 */
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseSpec } from "../spec";
import type { ITask } from "../spec";
import { buildGate, buildCoreFix } from "../gate";
import { runSpec } from "../loop";
import { runAccept, parserFor } from "../validate";
import type { ILoopEvent } from "../loop";
import type { IProvider } from "../inference";
import {
  classifyRun,
  countTaskLoc,
  judge,
  overBudgetScore,
  sizeWithinBudget,
  summarize,
} from "../eval";
import type { IJudgeScore, IRunRecord } from "../eval";
import { renderEvent } from "../render";
import { resetOverlayCache } from "./overlay";
import { meanProgress, runProgress } from "./progress";
import type { IHarnessOverlay, ISplitScore } from "./self-harness.types";
import type { IMinedRun } from "./mine";

export interface IEvaluateOptions {
  readonly corpusDir: string;
  /** Parent directory for this evaluation's run dirs (one per task × repeat). */
  readonly runsDir: string;
  readonly provider: IProvider;
  readonly repeats: number;
  /** The harness variant under test; null = base harness (no overlay). */
  readonly overlay: IHarnessOverlay | null;
  /** Judge green runs for quality (adds one model call per green run). When
   *  absent, quality stays unsignaled and the acceptance rule's quality guard
   *  is skipped for evals produced without it. */
  readonly judgeProvider?: IProvider;
  readonly temperature?: number;
  /** Cycle count at which a PASSED run still mines as `slow-green` (the
   *  efficiency signal). Default {@link SPEC_SLOW_THRESHOLD}. */
  readonly slowThreshold?: number;
  readonly log?: (line: string) => void;
}

/** Healthy spec-corpus runs green in 1–7 cycles; ≥8 is friction worth mining
 *  (query's measured 15–17-cycle crawls are the motivating case). */
export const SPEC_SLOW_THRESHOLD = 8;

export interface IEvaluateOutcome {
  readonly score: ISplitScore;
  /** Per-run event streams, for weakness mining (held-in only is mined, but
   *  returning them is cheap and keeps evaluate split-agnostic). */
  readonly runs: readonly IMinedRun[];
  /** Raw per-run records (labelled by task id) — the substrate for the proof
   *  protocol's Wilson-CI/z-test comparison (relabel per variant, then
   *  buildSweepReport). */
  readonly records: readonly IRunRecord[];
}

/** Copy the seed's files into a fresh run dir. */
async function setupRunDir(dir: string, seedDir: string): Promise<void> {
  await mkdir(dir, { recursive: true });

  for (const file of await readdir(seedDir, { recursive: true })) {
    const src = join(seedDir, file);

    if (!(await stat(src)).isDirectory()) {
      await Bun.write(join(dir, file), Bun.file(src));
    }
  }
}

/** Delete task files for scratch-mode seeds (brownfield keeps them RED). */
async function startRed(
  dir: string,
  spec: ReturnType<typeof parseSpec>
): Promise<void> {
  if (spec.mode !== "existing") {
    for (const task of spec.tasks) {
      for (const f of task.files) {
        await rm(join(dir, f), { force: true });
      }
    }
  }
}

/** Run a seed's optional setup.sh (brownfield git history). Trusted: the
 *  corpus is our own code — same stance as the eval sweep. A FAILED setup
 *  throws: it leaves the seed in the wrong starting state (e.g. green instead
 *  of the brownfield RED), which would silently invalidate the run's verdict —
 *  the caller records it as an errored run, never a task result. */
async function runSeedSetup(dir: string): Promise<void> {
  if (!(await Bun.file(join(dir, "setup.sh")).exists())) {
    return;
  }

  const proc = Bun.spawn(["sh", "setup.sh"], {
    cwd: dir,
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();

    throw new Error(
      `seed setup.sh exited ${String(exitCode)}: ${stderr.slice(0, 200)}`
    );
  }
}

/**
 * Run EVERY stage and fail if any did — the measurement join.
 *
 * The gate's own `&&` is fail-fast by design: the cheap static floor should
 * reject before anything pays for a test run. That is right for gating and
 * wrong for measuring. A failing gate's error count is whichever stage died
 * first, so a run going from 50 type errors to 3 type errors reads as 94%
 * resolved while every lint error behind it is still there, unseen and unfixed.
 * Under the acceptance rule that clears the promotion floor by a mile, and
 * nothing catches it: the same stage switch inflates held-in and held-out
 * together, and the fail-fast path uses FEWER cycles so the blowup veto stays
 * quiet too.
 *
 * SUBSHELLS, not brace groups. The stages are opaque strings assembled
 * elsewhere; run in this shell, an `exit 0`, a `set -e`, a trap, or an
 * assignment to the status variable would escape the wrapper and report success
 * for a failing stage. A subshell contains all of it, and its exit status is
 * still what the stage reported.
 */
export function allMustRun(parts: readonly string[]): string {
  if (parts.length === 0) {
    return "true";
  }

  const runs = parts
    .map(
      (part, i) =>
        `( ${part} ); __tsf_s${String(i)}=$?; [ "$__tsf_s${String(i)}" -eq 0 ] || __tsf_bad=1`
    )
    .join("; ");

  return `__tsf_bad=0; ${runs}; [ "$__tsf_bad" -eq 0 ]`;
}

/**
 * Gate errors right now, as one number — the fixed measurement the graded run
 * score is built from (see ./progress.ts). Deliberately the BARE gate, with no
 * task acceptance composed onto it, and with every stage run rather than
 * short-circuited, so the reading means the same thing whenever it is taken and
 * whatever the run was doing at the time.
 *
 * Returns null when the gate FAILED but produced nothing parseable — a crash, a
 * missing binary, a timeout. `validate` substitutes a single generic error there,
 * and taking that at face value would read a broken measurement as "1 error
 * left": from a start of 50 that is 89% progress for a run that may have done
 * nothing at all. Null is scored as no progress, not skipped, so the failure mode
 * can never flatter a candidate and can never drop an unflattering run out of the
 * denominator either.
 */
async function gateErrorCount(
  runDir: string,
  measureCommand: string
): Promise<number | null> {
  const task: ITask = { id: "__progress__", accept: measureCommand, files: [] };
  const result = await runAccept(task, runDir);

  if (result.passed) {
    return 0;
  }

  const parsed = parserFor(measureCommand)(result.output);

  return parsed.length > 0 ? parsed.length : null;
}

/** Gate every task and the whole-spec verify behind tsforge's strict floor —
 *  identical composition to the eval sweep, so scores are comparable. Left as
 *  the fail-fast `&&` the loop has always used: the graded score no longer reads
 *  these readings at all, so there is nothing here for this change to fix. */
function gateSpec(
  gateCommand: string,
  spec: ReturnType<typeof parseSpec>
): ReturnType<typeof parseSpec> {
  const fixCommand = buildCoreFix();

  return {
    ...spec,
    tasks: spec.tasks.map((t) => ({
      ...t,
      fix: fixCommand,
      accept: `${gateCommand} && ${t.accept}`,
    })),
    verify:
      spec.verify.length > 0 ? `${gateCommand} && ${spec.verify}` : gateCommand,
  };
}

/**
 * Every file the spec's solution lives in, deduped, in first-mention order.
 *
 * ALL tasks, not `spec.tasks[0]`. The judge used to read the first task's files
 * while `countTaskLoc` two lines away measured every task's — so quality and
 * size described different artifacts, and on a multi-task spec most of what the
 * model wrote was never looked at.
 *
 * GLOBBED, for the same reason. `ITask.files` holds scope patterns, not paths,
 * so treating `src/**\/*.ts` as a filename either errors on a file that does not
 * exist or silently reviews nothing — and `countTaskLoc` expands them, so a
 * literal reading would put quality and size back on different sets by another
 * route. Deduped because two tasks may legitimately name the same file, and
 * sending it twice wastes budget and shows the judge a doubled artifact.
 */
export async function solutionFiles(
  cwd: string,
  spec: { tasks: readonly { files: readonly string[] }[] }
): Promise<string[]> {
  const seen = new Set<string>();

  for (const pattern of spec.tasks.flatMap((t) => t.files)) {
    for await (const rel of new Bun.Glob(pattern).scan({
      cwd,
      onlyFiles: true,
    })) {
      seen.add(rel);
    }
  }

  return [...seen];
}

/**
 * Score the solution, or refuse to — and an EMPTY scope is refused.
 *
 * Judging nothing does not return nothing: the model invents a number for an
 * empty window, and that number becomes a quality reading for code it never saw.
 * `qualityRepair` already refuses this case for the same reason.
 *
 * It also stopped being self-correcting once files were globbed. A literal
 * missing path used to throw ENOENT and error the run, which at least blocked
 * promotion; an unmatched glob quietly expands to nothing. So a candidate
 * writing outside its declared scope while staying green would skip the quality
 * and concision comparison altogether.
 *
 * Refusing means the FLOOR, not silence — silence skips the guard, which is a
 * pass.
 */
async function scoreSolution(
  provider: IProvider,
  runDir: string,
  files: readonly string[],
  goal: string,
  criteria: string
): Promise<IJudgeScore> {
  if (files.length === 0) {
    return overBudgetScore();
  }

  return solutionFitsJudge(runDir, files, goal, criteria)
    ? judgeFiles(provider, runDir, files, goal, criteria)
    : overBudgetScore();
}

/** The quality figure the acceptance guard should see, or undefined for "not
 *  measured". See the call site for why an unusable answer is a 1 and not a
 *  skip. */
export function guardQuality(score: IJudgeScore): number | undefined {
  if (score.outcome === "scored") {
    return score.overall;
  }

  return score.outcome === "unreachable" ? undefined : QUALITY_FLOOR;
}

/** Bottom of the judge's 1–5 scale. */
const QUALITY_FLOOR = 1;

/**
 * Whether the solution is small enough to judge, decided from file SIZES.
 *
 * Sized before reading. Reading every file, joining them, and then encoding the
 * result to count bytes copies the whole artifact twice before concluding it was
 * too big to look at — so the path the budget exists to bound stayed unbounded
 * locally, just short of the model call. `Bun.file().size` is a stat.
 *
 * The arithmetic is the judge's own (`sizeWithinBudget`), not a second copy of
 * it: a short-circuit with its own threshold is a short-circuit that drifts, and
 * then either refuses inputs the judge would accept or materialises ones it
 * would not. Separators are counted because the join adds them.
 */
export function solutionFitsJudge(
  runDir: string,
  files: readonly string[],
  goal: string,
  criteria: string
): boolean {
  const separators = Math.max(0, files.length - 1) * SOLUTION_SEPARATOR.length;
  const code =
    files.reduce((sum, f) => sum + Bun.file(join(runDir, f)).size, 0) +
    separators;

  return sizeWithinBudget({
    goal: Buffer.byteLength(goal, "utf8"),
    criteria: Buffer.byteLength(criteria, "utf8"),
    code,
  });
}

/** What `judgeFiles` joins solution files with; counted in the size estimate so
 *  the pre-read check bounds the same string the judge will actually see. */
const SOLUTION_SEPARATOR = "\n\n";

/** Read the solution and score it. Split out so the size check above can refuse
 *  without this ever running — the point of checking before reading. */
async function judgeFiles(
  provider: IProvider,
  runDir: string,
  files: readonly string[],
  goal: string,
  criteria: string
): Promise<IJudgeScore> {
  const code = (
    await Promise.all(files.map((f) => Bun.file(join(runDir, f)).text()))
  ).join(SOLUTION_SEPARATOR);

  return judge(provider, { goal, criteria, code });
}

interface ITaskRunOutput {
  readonly record: IRunRecord;
  readonly run: IMinedRun;
}

async function runTaskOnce(
  taskId: string,
  runDir: string,
  opts: IEvaluateOptions
): Promise<ITaskRunOutput> {
  const seedDir = join(opts.corpusDir, taskId);

  await setupRunDir(runDir, seedDir);

  const spec = parseSpec(
    await Bun.file(join(runDir, `${taskId}.spec.md`)).text()
  );

  await startRed(runDir, spec);
  await runSeedSetup(runDir);

  const gate = await buildGate(runDir);
  const gateCommand = gate.command;
  // Every stage, not the fail-fast join — see allMustRun.
  const measureCommand = allMustRun(gate.parts ?? [gateCommand]);
  // Measured BEFORE the model starts, on the same command measured again after
  // it stops. startRed has already removed the task files, so this is the run's
  // honest opening state.
  const startErrors = await gateErrorCount(runDir, measureCommand);
  const gated = gateSpec(gateCommand, spec);
  const logFile = Bun.file(join(runDir, "run.log")).writer();
  const events: ILoopEvent[] = [];

  const onEvent = (e: ILoopEvent): void => {
    events.push(e);
    void logFile.write(renderEvent(e, { color: false }));
    void logFile.flush();
  };

  const result = await runSpec(gated, runDir, opts.provider, {
    onEvent,
    temperature: opts.temperature ?? 0,
  });

  await logFile.end();

  const passed = result.status === "done";
  const cycles = result.results.reduce((acc, r) => acc + r.cycles, 0);
  let loc: number | undefined;
  let quality: number | undefined;

  if (passed) {
    loc = (
      await countTaskLoc(
        runDir,
        spec.tasks.flatMap((t) => t.files)
      )
    ).totalLoc;

    if (opts.judgeProvider !== undefined && spec.tasks.length > 0) {
      const specText = await Bun.file(join(runDir, `${taskId}.spec.md`)).text();
      // EVERY task's files, not just the first. `loc` two lines up already
      // measures the whole spec, so scoring quality on task 1 alone judged a
      // different artifact than the one being measured — and on a multi-task
      // spec it silently ignored most of what the model wrote.
      const files = await solutionFiles(runDir, spec);
      const score = await scoreSolution(
        opts.judgeProvider,
        runDir,
        files,
        spec.title,
        specText
      );

      // The acceptance guard is SKIPPED when a side has no quality figure, so
      // "no signal" is a pass — and the judge's prompt contains candidate code,
      // which can ask for prose or an out-of-range number and switch the guard
      // off from inside the artifact being guarded. Anything the candidate can
      // provoke is therefore FLOORED, not skipped. Only `unreachable` (a dead
      // endpoint) stays unmeasured: infrastructure is nobody's doing, and the
      // mechanical gate is the real oracle regardless.
      quality = guardQuality(score);
    }
  }

  const failureClass = passed ? undefined : classifyRun(events).failureClass;
  // How far the run got, not merely whether it arrived. See ./progress.ts.
  const endErrors = passed ? 0 : await gateErrorCount(runDir, measureCommand);
  // A null on either end is an unusable measurement, scored as no progress —
  // never skipped, never taken at face value.
  const progress =
    startErrors === null || endErrors === null
      ? runProgress(0, 0, passed)
      : runProgress(startErrors, endErrors, passed);

  return {
    record: {
      label: taskId,
      passed,
      cycles,
      ms: 0,
      ...(quality === undefined ? {} : { quality }),
      ...(loc === undefined ? {} : { loc }),
      ...(failureClass === undefined ? {} : { failureClass }),
      progress,
    },
    run: {
      taskId,
      passed,
      events,
      slowThreshold: opts.slowThreshold ?? SPEC_SLOW_THRESHOLD,
    },
  };
}

/** Write the overlay under test (if any) and point the injection points at it
 *  for the duration of `body`. Restores the previous env + cache after. */
async function withOverlayEnv<T>(
  overlay: IHarnessOverlay | null,
  runsDir: string,
  body: () => Promise<T>
): Promise<T> {
  const saved = process.env.TSFORGE_SELF_HARNESS_OVERLAY;

  if (overlay === null) {
    delete process.env.TSFORGE_SELF_HARNESS_OVERLAY;
  } else {
    const path = join(runsDir, "overlay.json");

    await mkdir(runsDir, { recursive: true });
    await Bun.write(path, JSON.stringify(overlay, null, 2));
    process.env.TSFORGE_SELF_HARNESS_OVERLAY = path;
  }

  resetOverlayCache();

  try {
    return await body();
  } finally {
    if (saved === undefined) {
      delete process.env.TSFORGE_SELF_HARNESS_OVERLAY;
    } else {
      process.env.TSFORGE_SELF_HARNESS_OVERLAY = saved;
    }

    resetOverlayCache();
  }
}

/** Mean over per-task values that carry a real signal (>0), or 0 when none. */
function meanOfSignaled(values: readonly number[]): number {
  const signaled = values.filter((v) => v > 0);

  return signaled.length === 0
    ? 0
    : signaled.reduce((a, b) => a + b, 0) / signaled.length;
}

interface IRunSink {
  readonly records: IRunRecord[];
  readonly runs: IMinedRun[];
  readonly log: (line: string) => void;
  erroredCount: number;
}

function verdictLine(taskId: string, attempt: number, r: IRunRecord): string {
  return `    ${taskId} #${String(attempt)}: ${r.passed ? "green" : `red[${r.failureClass ?? "unknown"}]`} (${String(r.cycles)} cyc)`;
}

/** One spec-corpus run. A crash (endpoint timeout, connection failure) must
 *  not abort the evaluation — but it is NOT a task failure either: it counts
 *  as `errored` so the acceptance rule can refuse to blame/credit the edit
 *  for infrastructure weather. */
async function runOneSpec(
  taskId: string,
  attempt: number,
  runDir: string,
  opts: IEvaluateOptions,
  sink: IRunSink
): Promise<void> {
  try {
    const { record, run } = await runTaskOnce(taskId, runDir, opts);

    sink.records.push(record);
    sink.runs.push(run);
    sink.log(verdictLine(taskId, attempt, record));
  } catch (err) {
    sink.erroredCount += 1;
    sink.records.push({ label: taskId, passed: false, cycles: 0, ms: 0 });
    sink.log(
      `    ${taskId} #${String(attempt)}: ERRORED (${err instanceof Error ? err.message : String(err)})`
    );
  }
}

/**
 * Evaluate one harness variant on a task list (spec corpus tasks).
 * Sequential by design: the primary endpoint is a single-connection local
 * server, and sequential runs keep per-run wall-clock comparable across
 * candidates.
 */
export async function evaluateHarness(
  taskIds: readonly string[],
  opts: IEvaluateOptions
): Promise<IEvaluateOutcome> {
  return withOverlayEnv(opts.overlay, opts.runsDir, async () => {
    const sink: IRunSink = {
      records: [],
      runs: [],
      log: opts.log ?? ((): void => undefined),
      erroredCount: 0,
    };

    for (const taskId of taskIds) {
      for (let i = 0; i < opts.repeats; i += 1) {
        const runDir = join(
          opts.runsDir,
          `${taskId.replace(":", "-")}-${i + 1}`
        );

        // Every run starts from an empty directory. Run dir names are
        // deterministic (taskId-repeat) and get reused across campaign
        // launches and baseline retries, so without this a fresh run would
        // write ON TOP of the previous run's artifacts — leaving a mix of new
        // and stale files (logs from two different attempts in one dir, a
        // half-overwritten build) that is impossible to read honestly. Wipe
        // first so what's on disk is always exactly one run.
        await rm(runDir, { recursive: true, force: true });

        await runOneSpec(taskId, i + 1, runDir, opts, sink);
      }
    }

    const { records, runs, erroredCount: errored } = sink;

    const summaries = summarize(records);
    const perTask: Record<string, (typeof summaries)[number]> = {};

    for (const summary of summaries) {
      perTask[summary.label] = summary;
    }

    const score: ISplitScore = {
      passed: records.filter((r) => r.passed).length,
      runs: records.length,
      errored,
      avgQuality: meanOfSignaled(summaries.map((s) => s.avgQuality)),
      avgLoc: meanOfSignaled(summaries.map((s) => s.avgLoc)),
      // Mean over RUNS, not over tasks: a task measured twice should weigh
      // twice. A record with NO score is an errored one — it never reached
      // scoring — and meanProgress skips it, so an outage cannot enter the
      // graded figure as measured zero progress. Completed runs always carry a
      // number (0 when they produced no gate readings), so nothing that did run
      // can drop out of the denominator.
      avgProgress: meanProgress(records.map((r) => r.progress)),
      perTask,
    };

    return { score, runs, records };
  });
}
