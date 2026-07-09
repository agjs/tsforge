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
import { buildGate, buildCoreFix } from "../gate";
import { runSpec } from "../loop";
import type { ILoopEvent } from "../loop";
import type { IProvider } from "../inference";
import { classifyRun, countTaskLoc, judge, summarize } from "../eval";
import type { IRunRecord } from "../eval";
import { renderEvent } from "../render";
import { resetOverlayCache } from "./overlay";
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
  readonly log?: (line: string) => void;
}

export interface IEvaluateOutcome {
  readonly score: ISplitScore;
  /** Per-run event streams, for weakness mining (held-in only is mined, but
   *  returning them is cheap and keeps evaluate split-agnostic). */
  readonly runs: readonly IMinedRun[];
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
 *  corpus is our own code — same stance as the eval sweep. */
async function runSeedSetup(dir: string): Promise<void> {
  if (!(await Bun.file(join(dir, "setup.sh")).exists())) {
    return;
  }

  await Bun.spawn(["sh", "setup.sh"], {
    cwd: dir,
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
}

/** Gate every task and the whole-spec verify behind tsforge's strict floor —
 *  identical composition to the eval sweep, so scores are comparable. */
async function gateSpec(
  runDir: string,
  spec: ReturnType<typeof parseSpec>
): Promise<ReturnType<typeof parseSpec>> {
  const gateCommand = (await buildGate(runDir)).command;
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

  const gated = await gateSpec(runDir, spec);
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

    const firstTask = spec.tasks[0];

    if (opts.judgeProvider !== undefined && firstTask !== undefined) {
      const specText = await Bun.file(join(runDir, `${taskId}.spec.md`)).text();
      const code = (
        await Promise.all(
          firstTask.files.map((f) => Bun.file(join(runDir, f)).text())
        )
      ).join("\n\n");
      const score = await judge(opts.judgeProvider, {
        goal: spec.title,
        criteria: specText,
        code,
      });

      quality = score.scored ? score.overall : undefined;
    }
  }

  const failureClass = passed ? undefined : classifyRun(events).failureClass;

  return {
    record: {
      label: taskId,
      passed,
      cycles,
      ms: 0,
      ...(quality === undefined ? {} : { quality }),
      ...(loc === undefined ? {} : { loc }),
      ...(failureClass === undefined ? {} : { failureClass }),
    },
    run: { taskId, passed, events },
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

/**
 * Evaluate one harness variant on a task list. Sequential by design: the
 * primary endpoint is a single-connection local server, and sequential runs
 * keep per-run wall-clock comparable across candidates.
 */
export async function evaluateHarness(
  taskIds: readonly string[],
  opts: IEvaluateOptions
): Promise<IEvaluateOutcome> {
  return withOverlayEnv(opts.overlay, opts.runsDir, async () => {
    const records: IRunRecord[] = [];
    const runs: IMinedRun[] = [];
    const log = opts.log ?? ((): void => undefined);

    for (const taskId of taskIds) {
      for (let i = 0; i < opts.repeats; i += 1) {
        const runDir = join(opts.runsDir, `${taskId}-${i + 1}`);

        // One run's crash (endpoint timeout, spawn failure) records as a
        // failed run and the evaluation carries on — same resilience stance
        // as the sweep. Its events are empty, so mining skips it gracefully.
        try {
          const { record, run } = await runTaskOnce(taskId, runDir, opts);

          records.push(record);
          runs.push(run);
          log(
            `    ${taskId} #${i + 1}: ${record.passed ? "green" : `red[${record.failureClass ?? "unknown"}]`} (${record.cycles} cyc)`
          );
        } catch (err) {
          records.push({ label: taskId, passed: false, cycles: 0, ms: 0 });
          runs.push({ taskId, passed: false, events: [] });
          log(
            `    ${taskId} #${i + 1}: ERRORED (${err instanceof Error ? err.message : String(err)})`
          );
        }
      }
    }

    const summaries = summarize(records);
    const perTask: Record<string, (typeof summaries)[number]> = {};

    for (const summary of summaries) {
      perTask[summary.label] = summary;
    }

    const score: ISplitScore = {
      passed: records.filter((r) => r.passed).length,
      runs: records.length,
      avgQuality: meanOfSignaled(summaries.map((s) => s.avgQuality)),
      avgLoc: meanOfSignaled(summaries.map((s) => s.avgLoc)),
      perTask,
    };

    return { score, runs };
  });
}
