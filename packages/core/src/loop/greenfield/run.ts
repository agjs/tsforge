import type { Reporter } from "../loop.types";
import { saveState, writeProgress } from "./state";
import type {
  IGreenfieldState,
  IGreenfieldDeps,
  IGreenfieldOptions,
  IGreenfieldResult,
  IFeature,
} from "./greenfield.types";

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * The greenfield outer loop: drive a feature checklist to all-green, one feature
 * at a time, persisting state to disk after every step so a long run survives
 * being interrupted and resumed. Picks the first unfinished feature, asks the
 * model to implement it, runs the layered evaluator, ticks it on success — and
 * gives up on a single feature (status `stuck`) once it exhausts its attempts,
 * so a non-converging feature can't wedge the whole build. Filesystem state, not
 * context, is the source of truth (the workshop's long-run pattern).
 */
export async function runGreenfield(
  cwd: string,
  state: IGreenfieldState,
  deps: IGreenfieldDeps,
  opts: IGreenfieldOptions = {}
): Promise<IGreenfieldResult> {
  const maxAttempts = opts.maxAttemptsPerFeature ?? DEFAULT_MAX_ATTEMPTS;
  const report: Reporter = opts.onEvent ?? ((): void => undefined);

  const say = (message: string): void => {
    report({ kind: "fix", task: "greenfield", message });
  };

  await saveState(cwd, state);
  await writeProgress(cwd, state);

  for (;;) {
    const feature = state.features.find((f) => !f.passes);

    if (feature === undefined) {
      report({
        kind: "done",
        task: "greenfield",
        message: `all ${state.features.length} feature(s) verified`,
      });

      return { status: "done", features: state.features };
    }

    if (feature.attempts >= maxAttempts) {
      report({
        kind: "stuck",
        task: "greenfield",
        message: `feature '${feature.id}' stuck after ${feature.attempts} attempt(s)`,
        detail: feature.desc,
      });

      return {
        status: "stuck",
        features: state.features,
        stuckFeature: feature.id,
      };
    }

    await attemptFeature(cwd, state, feature, deps, say);
  }
}

/** One implement→evaluate→persist cycle for a single feature (mutates it). */
async function attemptFeature(
  cwd: string,
  state: IGreenfieldState,
  feature: IFeature,
  deps: IGreenfieldDeps,
  say: (message: string) => void
): Promise<void> {
  feature.attempts += 1;
  say(`feature '${feature.id}': attempt ${feature.attempts} — ${feature.desc}`);

  await deps.implement(feature, state);

  const verdict = await deps.evaluate(feature, state);

  if (verdict.passed) {
    feature.passes = true;
    say(`feature '${feature.id}': verified ✓`);
  } else {
    say(
      `feature '${feature.id}': failed at ${verdict.stage ?? "?"} — ${verdict.notes}`
    );
  }

  // Persist after every attempt so an interrupted run resumes from the last
  // verified feature, not from scratch.
  await saveState(cwd, state);
  await writeProgress(cwd, state);
}
