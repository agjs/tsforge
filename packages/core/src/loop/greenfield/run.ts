import type { Reporter } from "../loop.types";
import { saveState, writeProgress, loadState, writeSpec } from "./state";
import type { IPlan } from "./plan";
import type {
  IGreenfieldState,
  IGreenfieldDeps,
  IGreenfieldOptions,
  IGreenfieldResult,
  IFeature,
} from "./greenfield.types";

/**
 * Resolve the state to run: resume the persisted checklist if one exists, else
 * plan a fresh one from the goal (writing spec.md + features.json). Returns null
 * when there's no prior state AND planning yields nothing to build. The planner
 * is injected so this is testable without a model. Resume-first is the long-run
 * contract: an interrupted build picks up from the last verified feature.
 */
export async function prepareState(
  cwd: string,
  goal: string,
  plan: (goal: string) => Promise<IPlan | null>
): Promise<IGreenfieldState | null> {
  const existing = await loadState(cwd);

  if (existing !== null && existing.features.length > 0) {
    return existing;
  }

  const planned = await plan(goal);

  if (planned === null) {
    return null;
  }

  await writeSpec(cwd, planned.spec);

  const state: IGreenfieldState = { goal, features: planned.features };

  await saveState(cwd, state);

  return state;
}

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

  // Persist in `finally` so an implement/evaluate THROW still records the bumped
  // attempt count before it propagates — otherwise a crash on attempt N replays
  // as attempt N-1 on resume, and a repeatedly-crashing feature never reaches
  // `stuck`. The persisted state is the source of truth for resume-from-crash.
  try {
    await deps.implement(feature, state);

    const verdict = await deps.evaluate(feature, state);

    if (verdict.passed) {
      feature.passes = true;
      delete feature.lastError;
      say(`feature '${feature.id}': verified ✓`);
    } else {
      // Carry the failing output into the NEXT attempt (implement reads it) so the
      // model fixes the actual errors instead of rebuilding blind.
      feature.lastError = verdict.detail ?? verdict.notes;
      say(
        `feature '${feature.id}': failed at ${verdict.stage ?? "?"} — ${verdict.notes}`
      );
    }
  } finally {
    await saveState(cwd, state);
    await writeProgress(cwd, state);
  }
}
