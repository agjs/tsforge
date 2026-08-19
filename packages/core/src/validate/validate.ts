import type { ITask } from "../spec";
import type { ErrorParser, ErrorSet, IValidateResult } from "./validate.types";
import { runAccept, type IAcceptOptions } from "./accept";
import {
  capWithNotice,
  parserFor,
  isEslintJsonLine,
  eslintMessageSummary,
} from "./parse";

/** Longest fallback message we'll surface — a vite/render error fits; a wall of
 *  build logs does not. */
const FALLBACK_CAP = 1200;

/** Build the human-readable fallback message for a gate that failed without any
 *  parseable errors (e.g. a render/build failure). Drops eslint's machine JSON
 *  line — it's never for human eyes — and caps the length so the terminal isn't
 *  flooded with raw build output. */
export function fallbackMessage(output: string): string {
  const cleaned = output
    .split("\n")
    .filter((line) => !isEslintJsonLine(line))
    .join("\n")
    .trim();

  if (cleaned.length > 0) {
    return capWithNotice(cleaned, FALLBACK_CAP);
  }

  // Nothing readable remained after dropping eslint's JSON — but the gate DID
  // fail. If the JSON carried messages (e.g. a warnings-only `--max-warnings`
  // failure, which `parseEslintJson` drops as non-errors), surface those so the
  // loop has something concrete to fix instead of an opaque "non-zero".
  const eslintSummary = eslintMessageSummary(output);

  if (eslintSummary.length > 0) {
    return capWithNotice(eslintSummary.join("\n"), FALLBACK_CAP);
  }

  return "command exited non-zero";
}

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
  const fallback: ErrorSet = [
    {
      key: "nonzero",
      message: fallbackMessage(r.output),
    },
  ];

  return {
    passed: false,
    errors: parsed.length > 0 ? parsed : fallback,
    output: r.output,
  };
}
