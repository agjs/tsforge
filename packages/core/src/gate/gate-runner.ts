import type { ITask } from "../spec/spec.types";
import { validate } from "../validate";
import type { ErrorParser, IValidateResult } from "../validate";

/** Per-run hooks a gate/stage forwards to the underlying command runner. */
export interface IGateRunOpts {
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * One check contributing to a gate. Returns the standard validate shape so its
 * failures are `IErrorItem`s the loop's `checkStuck` can fingerprint and escalate
 * on — the whole point of composing the REAL gate inside the loop.
 */
export interface IStage {
  run(cwd: string, opts?: IGateRunOpts): Promise<IValidateResult>;
}

/**
 * The gate the loop runs each cycle. Injected into `settleGate` (via
 * `ctx.gate.runner`), replacing the hardcoded `--accept` shell. The default gate
 * (`commandGate`) is exactly today's `validate`, so brownfield is unchanged.
 */
export interface IGate {
  run(cwd: string, opts?: IGateRunOpts): Promise<IValidateResult>;
}

/**
 * Compose stages into one gate, run in series and SHORT-CIRCUITED: stages run
 * cheapest-first and the gate stops at the first failure, returning that stage's
 * result. So expensive stages (judge = a model call, browser = Playwright) run
 * ONLY when every cheaper stage is already green — a stalled unit that can't pass
 * the command stage never pays for a judge call.
 */
export function composeGate(stages: IStage[]): IGate {
  return {
    async run(cwd: string, opts?: IGateRunOpts): Promise<IValidateResult> {
      const outputs: string[] = [];

      for (const stage of stages) {
        const r = await stage.run(cwd, opts);

        outputs.push(r.output);

        if (!r.passed) {
          return {
            passed: false,
            errors: r.errors,
            output: outputs.join("\n"),
          };
        }
      }

      return { passed: true, errors: [], output: outputs.join("\n") };
    },
  };
}

/** The default gate: run the task's `--accept` command and parse it. Identical to
 *  today's loop behavior — the brownfield regression anchor. */
export function commandGate(task: ITask, parse?: ErrorParser): IGate {
  return {
    async run(cwd, opts) {
      // F19: external plugin content is frozen at load; drift must fail closed
      // before any gate stage runs (covers headless commandGate + brownfield).
      const { assertExternalPacksFrozen } = await import("../rule-packs");

      await assertExternalPacksFrozen();

      return validate(task, cwd, parse, opts ?? {});
    },
  };
}

/**
 * Wrap a stage so pre-existing BASELINE failures are suppressed and only NEW ones
 * surface. `baseline` is a set of failure-signature keys captured once at build
 * start; it lives in this closure, NOT in the task/ctx. When every current failure
 * is a baseline failure the feature introduced nothing broken → the wrapped stage
 * passes. This is boringstack's differential grading, generalized.
 */
export function differentialStage(
  inner: IStage,
  baseline: ReadonlySet<string>
): IStage {
  return {
    async run(cwd, opts): Promise<IValidateResult> {
      const r = await inner.run(cwd, opts);

      if (r.passed) {
        return r;
      }

      const novel = r.errors.filter((e) => !baseline.has(e.key));

      if (novel.length === 0) {
        return {
          passed: true,
          errors: [],
          output:
            `gate red, but all ${String(r.errors.length)} failure(s) are ` +
            `pre-existing baseline failures the feature cannot touch.`,
        };
      }

      const hidden = r.errors.length - novel.length;
      const note =
        hidden > 0 ? ` (${String(hidden)} baseline failure(s) hidden)` : "";

      return {
        passed: false,
        errors: novel,
        output: `NEW failures introduced by this feature${note}:\n${r.output}`,
      };
    },
  };
}
