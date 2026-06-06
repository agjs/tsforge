import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/loop";
import type { IProvider } from "../src/inference";
import { scripted, createStep, STOP } from "./stub-provider";

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
