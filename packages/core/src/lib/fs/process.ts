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
  /** Full environment for the child (REPLACES the inherited env, like Bun.spawn).
   *  Omit to inherit `process.env`. Pass `{ ...process.env, KEY: val }` to add a
   *  var while keeping the rest — e.g. the `--notify` hook injecting a status. */
  env?: Record<string, string | undefined>;
}

/** Result of `runShellCommand` — captured streams + how it ended. */
export interface IShellRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the kill-timeout fired (vs the command exiting on its own). */
  timedOut: boolean;
}

/** Conventional exit code for a process terminated by SIGKILL (128 + 9). */
const SIGKILL_EXIT = 137;

/** Captured-output bounds. Before these, a runaway gate command (a `yes`-style
 *  loop, a 100MB tsc/vitest log) was buffered WHOLE in memory — twice, since
 *  runAccept concatenates stdout+stderr — and every downstream cap only applied
 *  after the memory was already spent. Tail-biased on purpose: eslint's
 *  `--format json` emits its entire result as ONE huge line at the END of the
 *  gate output, and the tsc/test summaries also trail — the tail is what the
 *  parsers must see intact; the head keeps the banner identifying which stage
 *  ran. `onChunk` consumers still receive every chunk uncapped (live view). */
const CAPTURE_HEAD_CAP = 512 * 1024;
const CAPTURE_TAIL_CAP = 4 * 1024 * 1024;

export interface IBoundedCapture {
  append(text: string): void;
  /** The captured text — byte-identical to the input when under the caps,
   *  head + elision notice + tail otherwise. Idempotent. */
  text(): string;
}

/** A head+tail accumulator with an elision notice. Tail trimming is amortized
 *  (trim at 2× the cap back down to the cap) so appending N chars is O(N)
 *  total, not O(N²). The notice reuses the capWithNotice vocabulary
 *  ("output truncated") so downstream message-cap logic recognizes the family. */
/** A UTF-16 high surrogate (0xD800–0xDBFF) — the first half of an astral pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** A UTF-16 low surrogate (0xDC00–0xDFFF) — the second half of an astral pair. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function createBoundedCapture(
  headCap = CAPTURE_HEAD_CAP,
  tailCap = CAPTURE_TAIL_CAP
): IBoundedCapture {
  let head = "";
  let tail = "";
  let elided = 0;

  const trimTail = (limit: number): void => {
    if (tail.length > limit) {
      // Never cut BETWEEN a surrogate pair: if the kept-tail would start on a
      // low surrogate, drop it into the elided count so the pair isn't split
      // (harmless in the no-elision join, but the elision notice inserted
      // between the halves would otherwise strand two replacement chars).
      let keep = tailCap;

      if (isLowSurrogate(tail.charCodeAt(tail.length - keep))) {
        keep -= 1;
      }

      elided += tail.length - keep;
      tail = tail.slice(-keep);
    }
  };

  return {
    append(text: string): void {
      let rest = text;

      if (head.length < headCap) {
        let take = Math.min(headCap - head.length, rest.length);

        // Don't end the head on a lone high surrogate (its low half would land
        // in the tail, across the elision notice).
        if (take < rest.length && isHighSurrogate(rest.charCodeAt(take - 1))) {
          take -= 1;
        }

        head += rest.slice(0, take);
        rest = rest.slice(take);
      }

      if (rest.length > 0) {
        tail += rest;
        trimTail(2 * tailCap);
      }
    },
    text(): string {
      trimTail(tailCap);

      if (elided === 0) {
        return head + tail;
      }

      return (
        `${head}\n… (output truncated: ${String(elided)} characters elided — ` +
        `the full stream was forwarded live) …\n${tail}`
      );
    },
  };
}

/** After a kill is signalled, how long to wait for the process to actually be
 *  reaped before giving up — covers a child that escaped its group (e.g. called
 *  `setsid`) and so survives the group SIGKILL. Without this bound, `proc.exited`
 *  could never resolve and the tool would hang forever. */
const KILL_GRACE_MS = 2_000;
/** Once the awaited process is gone, how long to let the output pumps drain before
 *  returning regardless — a backgrounded/orphaned grandchild can keep the output
 *  pipe open indefinitely, so the read is ALWAYS bounded. It loses nothing: the
 *  pumps read concurrently, so all emitted output is already captured by now. */
const FLUSH_GRACE_MS = 500;

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
  // Prefer bash so `set -o pipefail` actually sticks. Debian/Ubuntu CI uses
  // dash as `/bin/sh`, which rejects pipefail — the old "probe then set"
  // form ran the command without pipefail and `false | cat` exited 0.
  return runArgvCommand(cwd, shellArgvWithPipefail(command), opts);
}

/**
 * POSIX single-quote a value for embedding in a shell command string. The ONE
 * quoting helper — any path/arg spliced into a command built for
 * `runShellCommand` goes through here, so a space or `$` in a directory name
 * can't split the word or expand.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Build `argv` for a shell that honors pipefail when bash is present. */
export function shellArgvWithPipefail(command: string): string[] {
  const bash = Bun.which("bash");

  if (bash !== null) {
    return [bash, "-c", `set -o pipefail; ${command}`];
  }

  return ["sh", "-c", command];
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
  const { signal, timeoutMs = 0, onChunk, env } = opts;

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
      ...(env === undefined ? {} : { env }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return { stdout: "", stderr: message, exitCode: 127, timedOut: false };
  }

  let timedOut = false;
  let resolveEscaped: (() => void) | null = null;
  // Held in an object so TS doesn't flow-narrow it to `null` for the cleanup below
  // (its only assignment is inside the killGroup closure, invisible to that flow).
  const escape: { timer: ReturnType<typeof setTimeout> | null } = {
    timer: null,
  };
  // Resolves only once a kill has been signalled AND the process still hasn't been
  // reaped a grace period later — i.e. it escaped its group and survived SIGKILL.
  // Racing it against `proc.exited` guarantees the wait below always settles.
  const escaped = new Promise<void>((resolve) => {
    resolveEscaped = resolve;
  });

  // Signal the whole process group (negative pid). Falls back to the lone child if
  // the group is already gone (ESRCH) or not permitted (EPERM) — never throws. Arms
  // the escape timer so a process that outlives the kill can't wedge the harness.
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

    escape.timer ??= setTimeout(() => resolveEscaped?.(), KILL_GRACE_MS);
  };

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

  const buf: { out: IBoundedCapture; err: IBoundedCapture } = {
    out: createBoundedCapture(),
    err: createBoundedCapture(),
  };

  const pump = async (
    stream: ReadableStream<Uint8Array>,
    key: "out" | "err"
  ): Promise<void> => {
    // Each pump gets its OWN decoder: a single shared TextDecoder retains the
    // trailing bytes of an incomplete UTF-8 sequence across `decode(…, {stream})`
    // calls, and the two pumps run concurrently — so a multibyte codepoint split
    // on a stdout chunk boundary would carry into the NEXT decode, which might be
    // the stderr pump, corrupting both streams (mojibake / bytes on the wrong
    // stream). A final flush decode emits any bytes left buffered at EOF (an
    // incomplete trailing sequence was otherwise silently dropped).
    const decoder = new TextDecoder();

    for await (const bytes of stream) {
      const text = decoder.decode(bytes, { stream: true });

      buf[key].append(text);

      if (onChunk !== undefined) {
        onChunk(text);
      }
    }

    const tail = decoder.decode();

    if (tail.length > 0) {
      buf[key].append(tail);

      if (onChunk !== undefined) {
        onChunk(tail);
      }
    }
  };

  try {
    const pumps = Promise.all([
      pump(proc.stdout, "out"),
      pump(proc.stderr, "err"),
    ]);

    // Wait for a clean exit, but give up if a killed process escaped its group and
    // can't be reaped (`escaped` resolves KILL_GRACE_MS after the kill) — otherwise
    // a `setsid`-detached server would leave this hanging forever.
    const exitCode = await Promise.race([
      proc.exited,
      escaped.then(() => SIGKILL_EXIT),
    ]);

    // ALWAYS bound the final drain: a backgrounded/orphaned grandchild can hold the
    // output pipe open long after the process we waited on is gone (Bun also leaves
    // a killed process's streams open), so the pumps could otherwise never resolve.
    // Clear the deadline when the pumps win so no timer lingers after a fast command.
    const flush: { timer: ReturnType<typeof setTimeout> | null } = {
      timer: null,
    };

    await Promise.race([
      pumps,
      new Promise<void>((resolve) => {
        flush.timer = setTimeout(resolve, FLUSH_GRACE_MS);
      }),
    ]);

    if (flush.timer !== null) {
      clearTimeout(flush.timer);
    }

    return {
      stdout: buf.out.text(),
      stderr: buf.err.text(),
      exitCode,
      timedOut,
    };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }

    if (escape.timer !== null) {
      clearTimeout(escape.timer);
    }

    if (signal !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
