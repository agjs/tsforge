import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runShellCommand,
  runArgvCommand,
  createBoundedCapture,
} from "../src/lib/fs/process";

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

// The shared runner must be able to inject env (the `--notify` hook passes
// $TSFORGE_STATUS this way). Without an `env` option, a notifier routed through
// the runner couldn't learn the run outcome.
test("runShellCommand passes a custom env to the child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-proc-env-"));

  try {
    const run = await runShellCommand(dir, 'printf "%s" "$TSFORGE_STATUS"', {
      timeoutMs: 5000,
      env: { ...process.env, TSFORGE_STATUS: "done 3/3" },
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("done 3/3");
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

test("pipefail keeps a failing left-hand command's exit through | cat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-proc-pipefail-"));

  try {
    const masked = await runShellCommand(dir, "false | cat", {
      timeoutMs: 5000,
    });

    // Without pipefail this would be 0 (cat). With it, false's 1 survives.
    expect(masked.exitCode).toBe(1);

    const ok = await runShellCommand(dir, "true | cat", { timeoutMs: 5000 });

    expect(ok.exitCode).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createBoundedCapture: under-cap output is byte-identical (parsers see the exact stream)", () => {
  const cap = createBoundedCapture(8, 8);

  cap.append("abc");
  cap.append("defgh");

  expect(cap.text()).toBe("abcdefgh");
});

test("createBoundedCapture: over-cap keeps head + tail with an elision notice and count", () => {
  const cap = createBoundedCapture(4, 4);

  // 4 head + 20 into the tail window (cap 4) → 16 elided.
  cap.append("HEAD");

  for (let i = 0; i < 5; i += 1) {
    cap.append("0123");
  }

  const text = cap.text();

  expect(text.startsWith("HEAD")).toBe(true);
  expect(text.endsWith("0123")).toBe(true);
  expect(text).toContain("output truncated: 16 characters elided");
  // Idempotent: a second read reports the same thing.
  expect(cap.text()).toBe(text);
});

test("createBoundedCapture: tail trimming is amortized, not O(n²)", () => {
  const cap = createBoundedCapture(16, 1024);
  const chunk = "x".repeat(64);
  const started = performance.now();

  for (let i = 0; i < 50_000; i += 1) {
    cap.append(chunk);
  }

  // ~3.2MB appended; O(n²) would take seconds here.
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(cap.text().length).toBeLessThanOrEqual(16 + 1024 + 120);
});

test("a multi-megabyte command output is captured bounded end-to-end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-boundedcap-"));

  try {
    // ~6MB of stdout: beyond head(512KB)+tail(4MB) → elision must kick in,
    // while both ends survive for the parsers.
    const r = await runShellCommand(
      dir,
      `bun -e 'const line = "y".repeat(1023); for (let i = 0; i < 6144; i++) console.log(line);'`,
      { timeoutMs: 60_000 }
    );

    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeLessThan(5 * 1024 * 1024);
    expect(r.stdout).toContain("output truncated");
    expect(r.stdout.startsWith("y")).toBe(true);
    expect(r.stdout.trimEnd().endsWith("y")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
