// Gate-runnable BOOT oracle: actually start the built server and confirm it comes
// up and answers a request without a 5xx. This is "does it RUN", a class of
// failure tsc/eslint/unit-tests never catch — a server that throws on boot
// (bad env wiring, a port clash, a top-level await that rejects) still type-checks
// and lints clean. Mirrors the web browser smoke, for backends.
//
// OPT-IN: wired into the gate only when TSFORGE_BOOT is set to the start command
// (e.g. `TSFORGE_BOOT="bun run start"`). TSFORGE_BOOT_URL (default
// http://localhost:3000/) and TSFORGE_BOOT_TIMEOUT (ms, default 15000) tune it.
//
//   TSFORGE_BOOT="bun run start" TSFORGE_BOOT_URL=http://localhost:3000/health bun boot-check.ts

export interface IBootConfig {
  readonly command: string;
  readonly url: string;
  readonly timeoutMs: number;
}

/** Read the boot config from env; null when TSFORGE_BOOT is not set. */
export function bootConfig(
  env: Record<string, string | undefined>
): IBootConfig | null {
  const command = env.TSFORGE_BOOT;

  if (command === undefined || command.trim().length === 0) {
    return null;
  }

  const timeoutRaw = Number(env.TSFORGE_BOOT_TIMEOUT);

  return {
    command,
    url: env.TSFORGE_BOOT_URL ?? "http://localhost:3000/",
    timeoutMs:
      Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 15000,
  };
}

/** Poll `url` until it answers with status < 500, or the deadline passes.
 *  Returns the status code on success, or null on timeout. */
export async function pollUntilReady(
  url: string,
  timeoutMs: number,
  now: () => number = () => performance.now(),
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms))
): Promise<number | null> {
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });

      if (res.status < 500) {
        return res.status;
      }
    } catch {
      // not up yet
    }

    await sleep(250);
  }

  return null;
}

async function main(): Promise<number> {
  const cfg = bootConfig(process.env);

  if (cfg === null) {
    return 0; // not configured — nothing to do
  }

  const child = Bun.spawn(["sh", "-c", cfg.command], {
    cwd: process.cwd(),
    // stdout is never consumed — discard it so a chatty server can't fill the pipe
    // and block on write. stderr we keep, but drain it continuously below.
    stdout: "ignore",
    stderr: "pipe",
    env: process.env,
    // Own process group, so the `finally` can kill the WHOLE group. The command runs
    // via `sh -c`, so `child.kill()` would only reap the shell wrapper and orphan the
    // actual server (it reparents to init and keeps holding the port → next gate run
    // clashes). Same fix as runArgvCommand. setsid isn't on macOS; `detached` is the
    // portable way to get a new group.
    detached: true,
  });

  // Drain stderr in the BACKGROUND into a capped tail. We must not await it to EOF:
  // on the success path the server stays alive, so the stream never ends — awaiting
  // would hang. A live reader also keeps the pipe from filling (which would block a
  // chatty server). `child.kill()` in `finally` closes the stream and ends the loop.
  let stderrTail = "";
  const drainStderr = (async (): Promise<void> => {
    const decoder = new TextDecoder();

    for await (const chunk of child.stderr) {
      stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(
        -2000
      );
    }
  })();

  void drainStderr.catch(() => undefined);

  try {
    const status = await pollUntilReady(cfg.url, cfg.timeoutMs);

    if (status === null) {
      process.stderr.write(
        // `stderrTail` is the LAST 2000 chars; take the last 800 of that — the
        // crash/traceback is at the end, not the start.
        `boot-check: server did not answer ${cfg.url} within ${cfg.timeoutMs}ms (or only returned 5xx). It must boot and serve a non-5xx response.\n${stderrTail.slice(-800)}\n`
      );

      return 1;
    }

    process.stdout.write(
      `boot-check: server answered ${cfg.url} with ${status}. OK\n`
    );

    return 0;
  } finally {
    // Kill the whole process group (negative pid) — the `sh -c` wrapper AND the
    // server it spawned. Fall back to the lone child if the group is already gone.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill();
      } catch {
        // already exited
      }
    }
  }
}

if (import.meta.main) {
  process.exit(await main());
}
