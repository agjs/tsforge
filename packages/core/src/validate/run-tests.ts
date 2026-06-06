/**
 * Run a single test file and report how many tests the runner collected.
 *
 * This is the deterministic answer to "are these real, runnable tests?" — we let
 * `bun test` be the oracle rather than counting `test(` calls by regex. The
 * load-bearing fact: an empty/vacuous file EXITS 0, so the exit code lies; only
 * the collected count (`total >= 1`) proves the suite actually asserts anything.
 */
import { readProcessOutput } from "../lib/fs";

import type { IRunTestsResult } from "./validate.types";

export async function runTests(
  testFile: string,
  cwd: string
): Promise<IRunTestsResult> {
  const proc = Bun.spawn(["bun", "test", testFile], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.exited;

  const { stdout, stderr } = await readProcessOutput(proc.stdout, proc.stderr);
  const output = stdout + stderr;

  return { ...countTests(output), output };
}

/**
 * The deterministic "real, runnable, RED suite" predicate: loads cleanly, has
 * tests, and every one fails against a do-nothing stub. Shared by test
 * generation and review so "acceptable suite" means one thing everywhere.
 */
export function isRealRed(run: IRunTestsResult): boolean {
  return run.errors === 0 && run.total >= 1 && run.pass === 0;
}

function countTests(output: string): {
  pass: number;
  fail: number;
  total: number;
  errors: number;
} {
  const pass = firstNumber(/(\d+)\s+pass/.exec(output));
  const fail = firstNumber(/(\d+)\s+fail/.exec(output));
  const ran = /Ran\s+(\d+)\s+tests?/.exec(output);
  const total = ran !== null ? firstNumber(ran) : pass + fail;

  const counted = firstNumber(/(\d+)\s+error/.exec(output));
  // bun sometimes prints the banner without a count; treat it as one error.
  const errors =
    counted > 0 || !output.includes("Unhandled error") ? counted : 1;

  return { pass, fail, total, errors };
}

function firstNumber(match: RegExpExecArray | null): number {
  const raw = match?.[1];

  return raw === undefined ? 0 : Number(raw);
}
