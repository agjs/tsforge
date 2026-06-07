import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, toRun, toRead, toEdits, toCreate } from "../src/agent";

test("toRead accepts the `file` arg", () => {
  expect(toRead({ file: "src/a.ts" })).toEqual({ file: "src/a.ts" });
});

test("toRead repairs the `path` alias the model reaches for", () => {
  // Regression: react-board run 1 spiraled because `read {path}` was rejected.
  expect(toRead({ path: "src/a.ts" })).toEqual({ file: "src/a.ts" });
  expect(toRead({ filename: "src/b.ts" })).toEqual({ file: "src/b.ts" });
  expect(toRead({ filePath: "src/c.ts" })).toEqual({ file: "src/c.ts" });
});

test("toRead returns null when no file-like arg is present", () => {
  expect(toRead({ nope: 1 })).toBeNull();
});

test("toEdits and toCreate also accept the `path` alias", () => {
  expect(toEdits({ path: "a.ts", oldString: "x", newString: "y" })).toEqual({
    file: "a.ts",
    edits: [{ oldString: "x", newString: "y" }],
  });
  expect(toCreate({ path: "a.ts", content: "hi" })).toEqual({
    file: "a.ts",
    content: "hi",
  });
});

test("runCommand returns stdout and exit code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-run-"));

  try {
    const r = await runCommand(dir, "echo hello");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCommand surfaces a non-zero exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-run-"));

  try {
    const r = await runCommand(dir, "exit 3");

    expect(r.exitCode).toBe(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCommand kills a hung command after its timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-run-"));

  try {
    const start = Date.now();
    const r = await runCommand(dir, "sleep 10", { timeoutMs: 150 });

    // Killed well before the 10s sleep would finish, with a clear note.
    expect(Date.now() - start).toBeLessThan(3000);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("timeout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCommand is cancelled when its signal aborts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-run-"));

  try {
    const controller = new AbortController();
    const start = Date.now();
    const pending = runCommand(dir, "sleep 10", { signal: controller.signal });

    controller.abort();
    const r = await pending;

    expect(Date.now() - start).toBeLessThan(3000);
    expect(r.exitCode).not.toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("toRun / toRead parse args and reject malformed", () => {
  expect(toRun({ command: "ls" })).toEqual({ command: "ls" });
  expect(toRun({})).toBeNull();
  expect(toRead({ file: "a.ts" })).toEqual({ file: "a.ts" });
  expect(toRead({ nope: 1 })).toBeNull();
});
