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

    await attemptFeature(cwd, state, feature, deps, say);
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

      await attemptFeature(cwd, state, feature, deps, say, seed);
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

/** One implement→evaluate→persist cycle for a single feature (mutates it).
 *  Optionally seeds the implement with prior tried-lever state (for a revisit). */
/** Safety backstop for evaluator-only stalls: a feature whose judge/browser keeps
 *  rejecting (with drifting wording, so the unchanged-rejection check never trips) is
 *  parked once its attempts reach this. Generous — the primary stop is the unchanged-
 *  rejection progress gate; this only catches a judge that never repeats itself. */
const EVAL_STALL_BACKSTOP = 12;

async function attemptFeature(
  cwd: string,
  state: IGreenfieldState,
  feature: IFeature,
  deps: IGreenfieldDeps,
  say: (message: string) => void,
  seed?: { triedLevers: string[] }
): Promise<void> {
  feature.attempts += 1;
  const seedNote = seed ? " (revisit, seeded with tried-levers)" : "";

  say(
    `feature '${feature.id}': attempt ${feature.attempts} — ${feature.desc}${seedNote}`
  );

  // Persist in `finally` so an implement/evaluate THROW still records the bumped
  // attempt count before it propagates — otherwise a crash on attempt N replays
  // as attempt N-1 on resume, and a repeatedly-crashing feature never reaches
  // `stuck`. The persisted state is the source of truth for resume-from-crash.
  try {
    const result = await deps.implement(feature, state, seed);

    // Check if the ladder is exhausted (handoff returned).
    if (result.handoff) {
      feature.parked = true;
      feature.handoff = result.handoff;
      say(`feature '${feature.id}': ladder exhausted, parked — revisit later`);

      return;
    }

    const verdict = await deps.evaluate(feature, state);

    if (verdict.passed) {
      feature.passes = true;
      delete feature.lastError;
      delete feature.parked;
      delete feature.handoff;
      say(`feature '${feature.id}': verified ✓`);
    } else {
      const newError = verdict.detail ?? verdict.notes;
      // Evaluator-only failures (implement returns NO handoff — the gate is green — but
      // the browser/judge rejects) have no inner ladder, so without a stop the main pass
      // would re-pick this feature forever. Progress-gate it: an UNCHANGED rejection
      // (same as last attempt → the judge isn't converging) parks the feature; a CHANGED
      // rejection is progress, so keep trying. A generous attempts backstop is the final
      // safety net for a judge whose wording drifts but never passes. Parking (not
      // failing) lets the revisit pass + "still parked → stuck" terminate cleanly.
      const notConverging = newError === feature.lastError;
      const hitBackstop = feature.attempts >= EVAL_STALL_BACKSTOP;

      feature.lastError = newError;

      if (notConverging || hitBackstop) {
        feature.parked = true;
        feature.handoff = {
          block: `evaluator:${feature.id}`,
          rungHistory: [],
          errors: [newError],
          ask:
            "the evaluator (browser/judge) keeps rejecting this feature without " +
            "converging — needs a human or a different approach",
          resumable: true,
          resume: { triedLevers: [] },
        };
        say(
          `feature '${feature.id}': evaluator not converging — parked (revisit later)`
        );
      } else {
        // Carry the failing output into the NEXT attempt (implement reads it) so the
        // model fixes the actual errors instead of rebuilding blind.
        say(
          `feature '${feature.id}': failed at ${verdict.stage ?? "?"} — ${verdict.notes}`
        );
      }
    }
  } finally {
    await saveState(cwd, state);
    await writeProgress(cwd, state);
  }
}
