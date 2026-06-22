import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellCommand, runArgvCommand } from "../src/lib/fs/process";

// P2 (review): a timed-out command killed only the `sh -c` wrapper, so a
// `&`-backgrounded grandchild survived and could still mutate the workspace AFTER
// the harness moved on. The fix spawns the child as its own process-group leader
// (`detached`) and kills the whole group on timeout — the grandchild dies too.
test("a timed-out command's backgrounded child cannot mutate afterwards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-proc-"));

  try {
    const marker = join(dir, "marker.txt");
    // The wrapper times out at 200ms while a detached child waits 600ms to write
    // the marker. With group-kill, the child is dead before it can touch the file.
    const run = await runShellCommand(
      dir,
      `(sleep 0.6; touch ${JSON.stringify(marker)}) & wait`,
      { timeoutMs: 200 }
    );

    expect(run.timedOut).toBe(true);

    // Wait past when the child WOULD have written, then confirm it never did.
    await Bun.sleep(800);

    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// THE WEDGE: a foreground command exits, but a backgrounded/orphaned child keeps
// the stdout pipe open. The drain (`new Response(stdout).text()`) then blocks on
// the open pipe — so a model that did `bun run dev` (or anything that leaves a
// server holding the pipe) would hang the whole harness with no escape. The drain
// must be bounded so the tool ALWAYS returns, losing none of the real output.
test("returns promptly even when a leftover child holds the output pipe open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-proc-pipe-"));

  try {
    const start = Bun.nanoseconds();
    // `echo` prints, then a detached child holds stdout open for 4s while the parent
    // `sh` exits immediately — the NON-killed path. Without the bounded drain the
    // read blocks the full 4s; with it, we return ~FLUSH_GRACE_MS later.
    const run = await runShellCommand(dir, "echo ready; sleep 4 &", {
      timeoutMs: 30_000,
    });
    const elapsedMs = (Bun.nanoseconds() - start) / 1e6;

    expect(run.timedOut).toBe(false);
    expect(run.stdout).toContain("ready");
    expect(elapsedMs).toBeLessThan(2500);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A missing binary must surface as exit 127 — NEVER a throw into the loop. If
// `Bun.spawn` rejects (ENOENT), the catch must convert it to a tool-error result
// so a model that runs a non-existent command gets feedback, not a crashed turn.
test("a missing binary returns exit 127 without throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-proc-127-"));

  try {
    const run = await runArgvCommand(
      dir,
      ["tsforge-nonexistent-binary-xyz", "--version"],
      { timeoutMs: 5000 }
    );

    expect(run.exitCode).toBe(127);
    expect(run.timedOut).toBe(false);
    expect(run.stderr.length).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a quick command still returns its output and does not report a timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-proc-ok-"));

  try {
    const run = await runShellCommand(dir, "echo hello-there", {
      timeoutMs: 5000,
    });

    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("hello-there");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
