import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/loop";
import type { IProvider, IModelResponse } from "../src/inference";
import { scripted, createStep, STOP } from "./stub-provider";

const gitStep = (op: string): IModelResponse => ({
  content: "",
  toolCalls: [{ name: "git_context", arguments: { op } }],
});

test("red-not-confirmed when the goalpost already passes — model never runs", async () => {
  let called = false;
  const provider: IProvider = {
    async complete() {
      called = true;

      return { content: "", toolCalls: [] };
    },
  };
  const r = await runTask(
    { id: "1", accept: "true", files: [] },
    ".",
    provider
  );

  expect(r.status).toBe("red-not-confirmed");
  expect(r.redConfirmed).toBe(false);
  expect(called).toBe(false);
});

// Greenfield uses requireRed:false because the global gate is often already green
// between features — the model must still build the feature, not bail RED-first.
test("requireRed:false runs the model even when the gate already passes", async () => {
  let called = false;
  const provider: IProvider = {
    async complete() {
      called = true;

      return { content: "", toolCalls: [] };
    },
  };
  const r = await runTask(
    { id: "1", accept: "true", files: [] },
    ".",
    provider,
    { requireRed: false }
  );

  expect(called).toBe(true); // the model ran despite green
  expect(r.status).not.toBe("red-not-confirmed");
});

test("stuck when the model never makes the goalpost pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-stuck-"));

  try {
    const r = await runTask(
      { id: "1", accept: "test -f done.txt", files: ["done.txt"] },
      dir,
      scripted([STOP])
    );

    expect(r.redConfirmed).toBe(true);
    expect(r.status).toBe("stuck");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stuck terminal from a narration (no-tool-call) turn reports edits/regressions as numbers", async () => {
  // The no-tool-call settle terminal used to return settleGate's result RAW,
  // which omits edits/regressions. The sweep does `r.regressions ?? 0`, so an
  // undefined here silently zeroed the regression signal for exactly the runs
  // that stalled while narrating. They must be numbers (like the other terminals).
  const dir = await mkdtemp(join(tmpdir(), "tsforge-noedit-metrics-"));

  try {
    const r = await runTask(
      { id: "1", accept: "test -f done.txt", files: ["done.txt"] },
      dir,
      scripted([STOP]) // never creates the file → red → narrate → stuck
    );

    expect(r.status).toBe("stuck");
    expect(typeof r.regressions).toBe("number");
    expect(typeof r.edits).toBe("number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("done when the model creates the file the goalpost needs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-done-"));

  try {
    const r = await runTask(
      { id: "1", accept: "test -f done.txt", files: ["done.txt"] },
      dir,
      scripted([createStep("done.txt", "x"), STOP])
    );

    expect(r.status).toBe("done");
    expect(r.cycles).toBe(1); // create turn auto-gates green — no extra stop turn
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a git_context tool call runs inside a full loop turn, then drives to done", async () => {
  // End-to-end through the real loop (not a direct executeTool call): the model
  // calls git_context, its result flows back as a tool message, the model then
  // creates the file the goalpost needs, and the gate settles green.
  const dir = await mkdtemp(join(tmpdir(), "tsforge-git-loop-"));

  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  // Don't inherit a global commit.gpgsign=true — signing via an unavailable agent
  // would make this temp-repo commit fail spuriously.
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: dir,
  });

  try {
    const r = await runTask(
      { id: "1", accept: "test -f done.txt", files: ["done.txt"] },
      dir,
      scripted([gitStep("log"), createStep("done.txt", "x"), STOP])
    );

    expect(r.status).toBe("done");
    // The git_context turn + the create turn both happened (no crash/stall).
    expect(r.cycles).toBeGreaterThanOrEqual(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runs the task's fix command before the gate (auto-fix)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-fix-"));

  try {
    const r = await runTask(
      {
        id: "1",
        accept: "test -f fixed.txt",
        files: [],
        fix: "touch fixed.txt",
      },
      dir,
      scripted([STOP])
    );

    expect(r.status).toBe("done"); // the fix step made the gate pass
    expect(r.cycles).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
