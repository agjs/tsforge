/**
 * Web-build evaluation for the Self-Harness loop: run benchmark-catalog apps
 * as verifiable tasks. Each app builds in a SUBPROCESS of headless-build.ts
 * (web-sweep precedent) — the overlay under test rides the inherited
 * TSFORGE_SELF_HARNESS_OVERLAY env; pass/fail is the exit code (the real web
 * gate + entity coverage decide it); the JSONL event log (via the script's
 * --log-file contract) feeds mining and the cycle/efficiency metrics.
 *
 * Subprocess isolation is a feature: each build gets a fresh provider and
 * session, and a driver crash is an *errored* run, never a fake verdict.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseEventLog } from "../eval";
import type { IRunRecord } from "../eval";
import { cycleCount, type IMinedRun } from "./mine";
import { classifyRun } from "../eval/failure-class";
import { resolveActiveModel, resolveApiKey } from "../models-config";
import type { ILoopEvent } from "../loop/loop.types";

/** Web builds legitimately run long (multi-entity apps, 180-turn cap); only a
 *  true crawl toward that cap mines as slow-green. */
export const WEB_SLOW_THRESHOLD = 100;

/** Default hard wall-clock cap per app build. */
export const WEB_RUN_TIMEOUT_MS = 90 * 60 * 1000;

export interface IWebEvaluateOptions {
  /** Directory for this evaluation's run dirs (one per app × repeat). */
  readonly runsDir: string;
  readonly repeats: number;
  /** Per-run wall-clock cap; a healthy-endpoint kill records as FAILED
   *  (timeout — minable), an unhealthy-endpoint kill as ERRORED. */
  readonly timeoutMs?: number;
  /** Probe the endpoint after a timeout/nonzero exit to decide failed vs
   *  errored. Injectable for tests; default probes the active model. */
  readonly probeHealthy?: () => Promise<boolean>;
  readonly log?: (line: string) => void;
}

export interface IWebRunOutcome {
  readonly record: IRunRecord;
  readonly run?: IMinedRun;
  readonly errored: boolean;
}

const HEADLESS_BUILD = join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "headless-build.ts"
);

async function defaultProbe(): Promise<boolean> {
  const { entry } = await resolveActiveModel();

  try {
    const key = resolveApiKey(entry);
    const res = await fetch(`${entry.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key === undefined ? {} : { Authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify({
        model: entry.model,
        messages: [{ role: "user", content: "ok?" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    return res.ok;
  } catch {
    return false;
  }
}

async function readEvents(logFile: string): Promise<ILoopEvent[]> {
  try {
    return parseEventLog(await Bun.file(logFile).text());
  } catch {
    return [];
  }
}

/** Run ONE catalog app once. Sequential caller-side — never parallelize
 *  (single-connection endpoint). */
export async function runWebTaskOnce(
  slug: string,
  runDir: string,
  opts: IWebEvaluateOptions
): Promise<IWebRunOutcome> {
  await mkdir(runDir, { recursive: true });

  const logFile = join(runDir, "events.jsonl");
  const proc = Bun.spawn(
    [
      "bun",
      HEADLESS_BUILD,
      "--app",
      slug,
      "react",
      runDir,
      "--log-file",
      logFile,
    ],
    {
      env: { ...process.env },
      stdout: Bun.file(join(runDir, "driver.log")),
      stderr: Bun.file(join(runDir, "driver.err.log")),
    }
  );

  const timeoutMs = opts.timeoutMs ?? WEB_RUN_TIMEOUT_MS;
  // Object property (not a bare let): the timer mutates it from a callback,
  // which TS flow analysis can't see — a boolean local would narrow to
  // `false` and read as an always-truthy conditional below.
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    proc.kill();
  }, timeoutMs);
  const exitCode = await proc.exited;

  clearTimeout(timer);

  const events = await readEvents(logFile);
  const passed = !state.timedOut && exitCode === 0;
  const taskId = `web:${slug}`;
  const cycles = cycleCount(events);

  if (passed) {
    return {
      errored: false,
      record: { label: taskId, passed: true, cycles, ms: 0 },
      run: { taskId, passed: true, events, slowThreshold: WEB_SLOW_THRESHOLD },
    };
  }

  // Not green. Blame allocation mirrors the spec path's hardening: only a
  // healthy endpoint makes this a real task failure the miner may learn from;
  // a sick endpoint makes it an errored run (no valid result — never a
  // verdict, in either direction).
  const healthy = await (opts.probeHealthy ?? defaultProbe)();

  if (!healthy) {
    return {
      errored: true,
      record: { label: taskId, passed: false, cycles: 0, ms: 0 },
    };
  }

  const failureClass = state.timedOut
    ? "timeout"
    : classifyRun(events).failureClass;

  return {
    errored: false,
    record: {
      label: taskId,
      passed: false,
      cycles,
      ms: 0,
      failureClass,
    },
    run: { taskId, passed: false, events, slowThreshold: WEB_SLOW_THRESHOLD },
  };
}
