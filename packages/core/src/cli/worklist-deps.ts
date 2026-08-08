import { composeGate } from "../gate/gate-runner";
import { validate } from "../validate";
import type { OpenAICompatibleProvider } from "../inference";
import { judgeStage } from "../loop/boringstack/gate-stages";
import { runTask } from "../loop";
import { RUN_STATUS } from "../loop/loop.constants";
import type { Reporter, IFeature, IGreenfieldDeps } from "../loop";

export interface IWorklistDepsOptions {
  cwd: string;
  /** Session / CLI default gate. */
  accept: string;
  /** Per-feature accept overrides (feature id → command). */
  accepts?: ReadonlyMap<string, string>;
  scope: string[];
  work: OpenAICompatibleProvider;
  evaluator: OpenAICompatibleProvider;
  report: Reporter;
  maxTurns?: number;
  thinkingTokenBudget?: number;
}

/**
 * Fresh `runTask` per worklist item — same shape as CLI `greenfieldDeps`, so a
 * long list does not share one drifting transcript across items.
 */
export function createWorklistDeps(
  opts: IWorklistDepsOptions
): IGreenfieldDeps {
  return {
    implement: async (feature: IFeature) => {
      const accept =
        opts.accepts?.get(feature.id) ??
        (opts.accept.length > 0 ? opts.accept : "true");

      const base = {
        id: feature.id,
        intent: feature.desc,
        accept,
        files: opts.scope,
        context: [],
      };

      const gate = composeGate([
        {
          run: (cwd, gateOpts) =>
            validate(base, cwd, undefined, gateOpts ?? {}),
        },
        judgeStage(opts.evaluator, opts.cwd, feature),
      ]);

      const result = await runTask(base, opts.cwd, opts.work, {
        onEvent: opts.report,
        gate,
        ...(opts.thinkingTokenBudget === undefined
          ? {}
          : { thinkingTokenBudget: opts.thinkingTokenBudget }),
        ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
      });

      return {
        done: result.status === RUN_STATUS.done,
        ...(result.handoff !== undefined ? { handoff: result.handoff } : {}),
      };
    },
  };
}
