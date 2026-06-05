import type { ITask } from "../spec/types";

export interface IAcceptResult {
  /** True when the command exits 0. */
  passed: boolean;
  /** Combined stdout + stderr, for feeding back into the loop. */
  output: string;
}

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
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { passed: exitCode === 0, output: stdout + stderr };
}
