import { test, expect } from "bun:test";
import { dbPushForce } from "../src/loop/boringstack/db-push";
import type { Exec, IExecResult } from "../src/loop/boringstack/exec";

const ok: IExecResult = { code: 0, stdout: "Changes applied", stderr: "" };

/** The exact drizzle-kit failure a name-less plan triggers headlessly. */
const RENAME_PROMPT_FAIL: IExecResult = {
  code: 1,
  stdout: "[✓] Pulling schema from database...",
  stderr:
    "Error: Interactive prompts require a TTY terminal (process.stdin.isTTY " +
    "is false).\n    at promptColumnsConflicts\n    at columnsResolver",
};

/** Record every argv the exec is asked to run, and return scripted results. */
function recordingExec(results: IExecResult[]): {
  exec: Exec;
  calls: string[][];
} {
  const calls: string[][] = [];
  let i = 0;

  const exec: Exec = (argv) => {
    calls.push([...argv]);
    const r = results[i] ?? ok;

    i += 1;

    return Promise.resolve(r);
  };

  return { exec, calls };
}

test("dbPushForce: push succeeds → single push, no drop", async () => {
  const { exec, calls } = recordingExec([ok]);

  const res = await dbPushForce("/api", exec, "bookmark");

  expect(res.code).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual(["bun", "run", "db:push", "--", "--force"]);
});

test("dbPushForce: rename-prompt failure → drops the entity table, then retries a clean push", async () => {
  const { exec, calls } = recordingExec([RENAME_PROMPT_FAIL, ok, ok]);

  const res = await dbPushForce("/api", exec, "bookmark");

  expect(res.code).toBe(0);
  expect(calls).toHaveLength(3);
  // 1: initial push (fails), 2: drop via bun -e, 3: retry push (clean create)
  expect(calls[0]).toEqual(["bun", "run", "db:push", "--", "--force"]);
  expect(calls[1]?.[0]).toBe("bun");
  expect(calls[1]?.[1]).toBe("-e");
  expect(calls[1]?.[2] ?? "").toContain(
    'DROP TABLE IF EXISTS "app"."bookmark" CASCADE'
  );
  expect(calls[2]).toEqual(["bun", "run", "db:push", "--", "--force"]);
});

test("dbPushForce: failure that is NOT the rename prompt → NOT masked (no drop, no retry)", async () => {
  // A genuinely broken schema (the model's own compile error) must surface, not be
  // hidden by a table drop + retry.
  const brokenSchema: IExecResult = {
    code: 1,
    stdout: "",
    stderr: 'error: relation "app.foo" type "jsonb" is not defined',
  };
  const { exec, calls } = recordingExec([brokenSchema]);

  const res = await dbPushForce("/api", exec, "bookmark");

  expect(res.code).toBe(1);
  expect(calls).toHaveLength(1);
});

test("dbPushForce: rename-prompt failure but NO entityTable → cannot recover, returns the failure", async () => {
  const { exec, calls } = recordingExec([RENAME_PROMPT_FAIL]);

  const res = await dbPushForce("/api", exec);

  expect(res.code).toBe(1);
  expect(calls).toHaveLength(1);
});

test("dbPushForce: an unsafe (non-identifier) entityTable is never interpolated into SQL", async () => {
  const { exec, calls } = recordingExec([RENAME_PROMPT_FAIL]);

  const res = await dbPushForce("/api", exec, "bookmark; DROP TABLE users;--");

  // Rejected by the identifier guard → no drop, no retry; the failure is returned.
  expect(res.code).toBe(1);
  expect(calls).toHaveLength(1);
});
