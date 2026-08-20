/**
 * Run a single test file and report how many tests the runner collected.
 *
 * This is the deterministic answer to "are these real, runnable tests?" — we let
 * `bun test` be the oracle rather than counting `test(` calls by regex. The
 * load-bearing fact: an empty/vacuous file EXITS 0, so the exit code lies; only
 * the collected count (`total >= 1`) proves the suite actually asserts anything.
 */
import { runArgvCommand } from "../lib/fs";
import { normalizeGateOutput } from "./parse";

import type { IRunTestsResult } from "./validate.types";

export async function runTests(
  testFile: string,
  cwd: string
): Promise<IRunTestsResult> {
  // Route through the shared runner, which drains stdout/stderr CONCURRENTLY
  // with the process. Awaiting `proc.exited` before reading (the old code) can
  // deadlock when a chatty test fills the pipe buffer — the child blocks on a
  // full pipe while we wait for an exit that never arrives.
  const run = await runArgvCommand(cwd, ["bun", "test", testFile]);
  const output = run.stdout + run.stderr;

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

function countTests(rawOutput: string): {
  pass: number;
  fail: number;
  total: number;
  errors: number;
} {
  const output = normalizeGateOutput(rawOutput);
  // Anchor to bun's SUMMARY lines (` N pass`, ` N fail`, ` N error`, `Ran N
  // tests …`) — the count must be the line's first token — and take the LAST
  // match. The old code took the FIRST `\d+ pass|fail` ANYWHERE in the merged
  // stdout+stderr, so a test's own console output (e.g. `console.log("0 pass 5
  // fail")`) or an assertion diff spoofed the counts, and `isRealRed` could
  // accept a passing suite as a real RED one — a false TDD-floor pass.
  const pass = lastLineNumber(output, /^\s*(\d+)\s+pass\b/) ?? 0;
  const fail = lastLineNumber(output, /^\s*(\d+)\s+fail\b/) ?? 0;
  const ran = lastLineNumber(output, /^\s*Ran\s+(\d+)\s+tests?\b/);
  const total = ran ?? pass + fail;

  const counted = lastLineNumber(output, /^\s*(\d+)\s+errors?\b/);
  // bun sometimes prints the load-error banner without a leading count; treat a
  // present-but-uncounted `Unhandled error` as one error so a load failure is
  // never scored as a clean (errors:0) RED suite.
  const errors = counted ?? (output.includes("Unhandled error") ? 1 : 0);

  return { pass, fail, total, errors };
}

/** The number captured by `re` on the LAST line that matches it, or undefined
 *  when no line does. Per-line + last-match so a summary line wins over any
 *  earlier log/diff text that happens to contain the same tokens. */
function lastLineNumber(output: string, re: RegExp): number | undefined {
  let found: number | undefined;

  for (const line of output.split("\n")) {
    const m = re.exec(line);

    if (m?.[1] !== undefined) {
      found = Number(m[1]);
    }
  }

  return found;
}
