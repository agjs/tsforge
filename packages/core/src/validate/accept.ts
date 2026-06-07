import type { ITask } from "../spec";
import { runShellCommand } from "../lib/fs";

import type { IAcceptResult } from "./validate.types";

/** Default kill-timeout for the GATE (ms). More generous than the `run` tool —
 *  a web gate is `vite build` + headless chromium, legitimately slow — but still
 *  bounded so a stuck build can't wedge the harness. TSFORGE_GATE_TIMEOUT_MS to
 *  override (0 = no timeout). */
const DEFAULT_GATE_TIMEOUT_MS = 600_000;

function gateTimeoutMs(): number {
  const env = Number(process.env.TSFORGE_GATE_TIMEOUT_MS);

  return Number.isFinite(env) && env >= 0 ? env : DEFAULT_GATE_TIMEOUT_MS;
}

/** Optional knobs for `runAccept`: stream the output live (`onChunk`) and/or
 *  cancel it (`signal`). */
export interface IAcceptOptions {
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * Run a task's `accept:` command in `cwd`. This is the deterministic oracle in
 * miniature — pass/fail comes from the exit code, never from model judgment.
 * Pass `onChunk` to stream the command's output live (the CLI does, so a slow
 * gate like `vite build` + browser isn't silent); omit it and output is just
 * captured (the eval path). Cancellable via `signal`, and killed after the gate
 * timeout so a hung build can't wedge the harness.
 */
export async function runAccept(
  task: ITask,
  cwd: string,
  opts: IAcceptOptions = {}
): Promise<IAcceptResult> {
  const run = await runShellCommand(cwd, task.accept, {
    timeoutMs: gateTimeoutMs(),
    ...(opts.onChunk === undefined ? {} : { onChunk: opts.onChunk }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });

  const note = run.timedOut
    ? `\n[gate killed after ${gateTimeoutMs()}ms timeout — TSFORGE_GATE_TIMEOUT_MS to change]`
    : "";

  return { passed: run.exitCode === 0, output: run.stdout + run.stderr + note };
}
