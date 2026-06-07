import type { ITask } from "../spec";
import type { ErrorParser, ErrorSet, IValidateResult } from "./validate.types";
import { runAccept, type IAcceptOptions } from "./accept";
import { parserFor } from "./parse";

/**
 * Run a task's gate and turn the result into a structured error set. When no
 * parser is given, one is auto-picked from the command (tsc/eslint/generic).
 * `opts` forwards live-output streaming (`onChunk`) and cancellation (`signal`)
 * down to the gate process.
 */
export async function validate(
  task: ITask,
  cwd: string,
  parse?: ErrorParser,
  opts: IAcceptOptions = {}
): Promise<IValidateResult> {
  const parser = parse ?? parserFor(task.accept);
  const r = await runAccept(task, cwd, opts);

  if (r.passed) {
    return { passed: true, errors: [], output: r.output };
  }

  // A failing gate must surface at least one error, even with empty output.
  const parsed = parser(r.output);
  const trimmed = r.output.trim();
  const fallback: ErrorSet = [
    {
      key: "nonzero",
      message: trimmed.length > 0 ? trimmed : "command exited non-zero",
    },
  ];

  return {
    passed: false,
    errors: parsed.length > 0 ? parsed : fallback,
    output: r.output,
  };
}
