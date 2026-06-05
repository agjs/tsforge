import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, toRun, toRead } from "../src/agent/tools";

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

test("toRun / toRead parse args and reject malformed", () => {
  expect(toRun({ command: "ls" })).toEqual({ command: "ls" });
  expect(toRun({})).toBeNull();
  expect(toRead({ file: "a.ts" })).toEqual({ file: "a.ts" });
  expect(toRead({ nope: 1 })).toBeNull();
});
