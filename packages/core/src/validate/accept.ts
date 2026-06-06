import type { ITask } from "../spec";
import { readProcessOutput } from "../lib/fs";

import type { IAcceptResult } from "./validate.types";

/**
 * Run a task's `accept:` command in `cwd`. This is the deterministic oracle in
 * miniature — pass/fail comes from the exit code, never from model judgment.
 */
export async function runAccept(
  task: ITask,
  cwd: string
): Promise<IAcceptResult> {
  const proc = Bun.spawn(["sh", "-c", task.accept], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const { stdout, stderr } = await readProcessOutput(proc.stdout, proc.stderr);

  return { passed: exitCode === 0, output: stdout + stderr };
}
