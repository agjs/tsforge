import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellCommand } from "../src/lib/fs/process";

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
