import type { Reporter, EscalationRung } from "../loop.types";
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

/**
 * The greenfield outer loop: drive a feature checklist to all-green, one feature
 * at a time, persisting state to disk after every step so a long run survives
 * being interrupted and resumed. Picks the first unfinished feature, asks the
 * model to implement it, runs the layered evaluator, ticks it on success. When
 * `implement` returns a handoff (escalation ladder exhausted), the feature parks
 * and the loop continues to the next. After the main pass, a single revisit pass
 * retries parked features seeded with their saved tried-lever state.
 * Filesystem state, not context, is the source of truth (the workshop's long-run pattern).
 */
export async function runGreenfield(
  cwd: string,
  state: IGreenfieldState,
  deps: IGreenfieldDeps,
  opts: IGreenfieldOptions = {}
): Promise<IGreenfieldResult> {
  const report: Reporter = opts.onEvent ?? ((): void => undefined);

  const say = (message: string): void => {
    report({ kind: "fix", task: "greenfield", message });
  };

  await saveState(cwd, state);
  await writeProgress(cwd, state);

  // Main pass: drive all unpassed, unparked features.
  for (;;) {
    const feature = state.features.find(
      (f) => !f.passes && !(f.parked ?? false)
    );

    if (feature === undefined) {
      break;
    }

    const infraError = await attemptFeature(cwd, state, feature, deps, say);

    if (infraError !== undefined) {
      return {
        status: "needs-infra",
        features: state.features,
        infra: infraError,
      };
    }
  }

  // Revisit pass: retry parked features once, seeding with their saved tried-lever state.
  const parkedFeatures = state.features.filter(
    (f) => (f.parked ?? false) && !f.passes
  );

  if (parkedFeatures.length > 0) {
    say(`${parkedFeatures.length} parked feature(s) to revisit`);

    for (const feature of parkedFeatures) {
      feature.parked = false;

      const seed = feature.handoff?.resume
        ? "triedLevers" in feature.handoff.resume
          ? { triedLevers: feature.handoff.resume.triedLevers }
          : undefined
        : undefined;

      const infraError = await attemptFeature(
        cwd,
        state,
        feature,
        deps,
        say,
        seed
      );

      if (infraError !== undefined) {
        return {
          status: "needs-infra",
          features: state.features,
          infra: infraError,
        };
      }
    }
  }

  // Final verdict
  const allPassing = state.features.every((f) => f.passes);

  if (allPassing) {
    report({
      kind: "done",
      task: "greenfield",
      message: `all ${state.features.length} feature(s) verified`,
    });

    return { status: "done", features: state.features };
  }

  const stillParked = state.features.filter((f) => f.parked ?? false);

  if (stillParked.length > 0) {
    report({
      kind: "stuck",
      task: "greenfield",
      message: `${stillParked.length} feature(s) remain parked after revisit`,
      detail: stillParked.map((f) => f.id).join(", "),
    });

    return {
      status: "stuck",
      features: state.features,
      stuckFeature: stillParked[0]?.id,
    };
  }

  // Unreachable: if no feature is passing and none are parked, the main pass would
  // have looped forever. But defensive: report the first non-passing feature.
  const nonPassing = state.features.find((f) => !f.passes);

  report({
    kind: "stuck",
    task: "greenfield",
    message: `feature '${nonPassing?.id ?? "unknown"}' did not reach verdict`,
  });

  return {
    status: "stuck",
    features: state.features,
    stuckFeature: nonPassing?.id,
  };
}

/** One implement cycle for a single feature (mutates it).
 *  Optionally seeds the implement with prior tried-lever state (for a revisit).
 *  Returns an infra error string if infrastructure is unavailable (e.g., API/browser down). */
async function attemptFeature(
  cwd: string,
  state: IGreenfieldState,
  feature: IFeature,
  deps: IGreenfieldDeps,
  say: (message: string) => void,
  seed?: { triedLevers: EscalationRung[] }
): Promise<string | undefined> {
  feature.attempts += 1;
  const seedNote = seed ? " (revisit, seeded with tried-levers)" : "";

  say(
    `feature '${feature.id}': attempt ${feature.attempts} — ${feature.desc}${seedNote}`
  );

  // Persist in `finally` so an implement THROW still records the bumped attempt
  // count before it propagates — otherwise a crash on attempt N replays as attempt
  // N-1 on resume, and a repeatedly-crashing feature never reaches `stuck`. The
  // persisted state is the source of truth for resume-from-crash.
  try {
    const result = await deps.implement(feature, state, seed);

    // Infrastructure error: thread it up to the outer loop to return needs-infra
    if (result.infra !== undefined) {
      say(
        `feature '${feature.id}': infrastructure unavailable — cannot verify. Halting build.`
      );

      return result.infra;
    }

    if (result.done) {
      feature.passes = true;
      delete feature.lastError;
      delete feature.parked;
      delete feature.handoff;
      say(`feature '${feature.id}': verified ✓`);

      return undefined;
    }

    // Not done → the shared ladder (R1–R4 + R5) already ran inside the loop and
    // exhausted. Park on its structured handoff for the revisit pass.
    feature.parked = true;

    if (result.handoff !== undefined) {
      feature.handoff = result.handoff;
    }

    say(`feature '${feature.id}': ladder exhausted, parked — revisit later`);

    return undefined;
  } finally {
    await saveState(cwd, state);
    await writeProgress(cwd, state);
  }
}
