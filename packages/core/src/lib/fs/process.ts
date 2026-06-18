/** Drain a spawned process's piped stdout + stderr to strings (the one place
 *  this Bun pattern lives). Pass `proc.stdout, proc.stderr` from a process
 *  spawned with `stdout: "pipe", stderr: "pipe"`. */
export async function readProcessOutput(
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>
): Promise<{ stdout: string; stderr: string }> {
  const [out, err] = await Promise.all([
    new Response(stdout).text(),
    new Response(stderr).text(),
  ]);

  return { stdout: out, stderr: err };
}

/** Options for `runShellCommand` — cancellation, an optional kill-timeout, and
 *  optional live output streaming. */
export interface IShellRunOptions {
  /** Abort signal — when it fires, the child process is killed. */
  signal?: AbortSignal;
  /** Kill the process after this many ms (0 / omitted = no timeout). */
  timeoutMs?: number;
  /** Forward each decoded output chunk live; omit to just capture. */
  onChunk?: (text: string) => void;
}

/** Result of `runShellCommand` — captured streams + how it ended. */
export interface IShellRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the kill-timeout fired (vs the command exiting on its own). */
  timedOut: boolean;
}

/**
 * Spawn `sh -c command` in `cwd` and capture stdout/stderr — the ONE place that
 * runs a shell command for the harness (the `run` tool and the gate both route
 * here), so cancellation and the kill-timeout are enforced uniformly. A pending
 * `signal` abort or an elapsed `timeoutMs` kills the child (otherwise a model-
 * issued `vite dev`/`tail -f`/hung test would wedge the harness with no escape).
 * `onChunk` streams output live; without it output is just captured.
 */
export async function runShellCommand(
  cwd: string,
  command: string,
  opts: IShellRunOptions = {}
): Promise<IShellRun> {
  return runArgvCommand(cwd, ["sh", "-c", command], opts);
}

/**
 * Like `runShellCommand`, but spawns an explicit argv with NO shell — so
 * arguments are passed literally and can't be expanded/injected (`$()`, backticks,
 * globbing). Use this for any command built from model- or content-supplied
 * values (e.g. ripgrep patterns). A missing binary resolves to exit 127, not a
 * throw, so callers can degrade gracefully.
 */
export async function runArgvCommand(
  cwd: string,
  argv: string[],
  opts: IShellRunOptions = {}
): Promise<IShellRun> {
  const { signal, timeoutMs = 0, onChunk } = opts;

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;

  try {
    // `detached: true` makes the child its OWN process-group leader (pgid == pid),
    // so the kill below can take down the whole group — the `sh -c` wrapper AND any
    // `&`-backgrounded grandchildren. Without it, killing only the wrapper leaves a
    // `(sleep …; touch x) &` child running, which then reparents to init and can
    // still mutate the workspace after a timeout/abort. (setsid isn't on macOS, so
    // `detached` is the portable way to get a new group.)
    proc = Bun.spawn(argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return { stdout: "", stderr: message, exitCode: 127, timedOut: false };
  }

  // Signal the whole process group (negative pid). Falls back to the lone child if
  // the group is already gone (ESRCH) or not permitted (EPERM) — never throws.
  const killGroup = (): void => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    }
  };

  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killGroup();
        }, timeoutMs)
      : null;

  const onAbort = (): void => {
    killGroup();
  };

  if (signal !== undefined) {
    if (signal.aborted) {
      killGroup();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const decoder = new TextDecoder();
  const buf: { out: string; err: string } = { out: "", err: "" };
  // Read through a closure so control-flow analysis treats these as `boolean`
  // (the setTimeout/abort mutations are invisible to it, else it narrows to
  // literal `false` and the kill branch reads as dead code).
  const wasKilled = (): boolean => timedOut || (signal?.aborted ?? false);

  const pump = async (
    stream: ReadableStream<Uint8Array>,
    key: "out" | "err"
  ): Promise<void> => {
    for await (const bytes of stream) {
      const text = decoder.decode(bytes, { stream: true });

      buf[key] += text;

      if (onChunk !== undefined) {
        onChunk(text);
      }
    }
  };

  try {
    const pumps = Promise.all([
      pump(proc.stdout, "out"),
      pump(proc.stderr, "err"),
    ]);
    const exitCode = await proc.exited;

    // A KILLED process can leave its piped streams open in Bun, so the pumps
    // would hang forever — flush briefly, then return what we captured. On a
    // normal exit the streams close and the pumps resolve on their own.
    await (wasKilled()
      ? Promise.race([
          pumps,
          new Promise<void>((resolve) => setTimeout(resolve, 100)),
        ])
      : pumps);

    return { stdout: buf.out, stderr: buf.err, exitCode, timedOut };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }

    if (signal !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
