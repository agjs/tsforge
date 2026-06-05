import type { ISpec } from "../spec/types";
import type { IProvider } from "../inference/types";
import { validate, type ErrorParser } from "../validate/validate";
import { runTask, type IRunResult } from "./run";
import type { Reporter } from "./events";

export interface ISpecResult {
  status: "done" | "blocked";
  results: IRunResult[];
}

export interface IRunSpecOptions {
  parse?: ErrorParser;
  onEvent?: Reporter;
  temperature?: number;
  enableThinking?: boolean;
  thinkingTokenBudget?: number;
}

/**
 * Run a spec's tasks in listed order. Each task goes through the implement
 * loop; the first task that doesn't reach `done` blocks the spec. When all
 * tasks pass, the whole-spec `verify` gate must also pass.
 *
 * (Dependency ordering via `needs:` is a later slice — v1 is file order.)
 */
export async function runSpec(
  spec: ISpec,
  cwd: string,
  provider: IProvider,
  opts: IRunSpecOptions = {}
): Promise<ISpecResult> {
  const { parse, onEvent, temperature, enableThinking, thinkingTokenBudget } =
    opts;
  const report: Reporter = onEvent ?? (() => undefined);
  const results: IRunResult[] = [];

  for (const task of spec.tasks) {
    const result = await runTask(task, cwd, provider, {
      parse,
      onEvent,
      temperature,
      enableThinking,
      thinkingTokenBudget,
    });

    results.push(result);

    if (result.status !== "done") {
      report({
        kind: "stuck",
        task: task.id,
        message: `spec "${spec.id}" blocked at task ${task.id}`,
      });

      return { status: "blocked", results };
    }
  }

  // Whole-spec gate: every task is green, now the spec's own verify must pass.
  if (spec.verify.length > 0) {
    report({
      kind: "start",
      task: "verify",
      message: `whole-spec verify: ${spec.verify}`,
    });

    const verified = await validate(
      { id: "verify", accept: spec.verify, files: [] },
      cwd,
      parse
    );

    report({
      kind: "validated",
      task: "verify",
      passed: verified.passed,
      errors: verified.errors.length,
      message: verified.passed
        ? "whole-spec verify: GREEN"
        : `whole-spec verify: red (${verified.errors.length} error(s))`,
    });

    if (!verified.passed) {
      return { status: "blocked", results };
    }
  }

  report({ kind: "done", task: spec.id, message: `spec "${spec.id}": done` });

  return { status: "done", results };
}
