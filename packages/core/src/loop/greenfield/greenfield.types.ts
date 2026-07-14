import type { IStep } from "../../browser";
import type { Reporter, IHandoff } from "../loop.types";

/**
 * One feature in a greenfield build's checklist. The unit the outer loop drives:
 * pick the first one not yet `passes`, implement it, verify it, tick it. Persisted
 * to `.tsforge/greenfield/features.json` — filesystem state the model can't
 * silently lose across a multi-hour run (the workshop's "JSON resists overwrite").
 */
export interface IFeature {
  /** Stable id (kebab-case), used in progress.md and logs. */
  id: string;
  /** One-line description of the behaviour to build. */
  desc: string;
  /** Verified working (gate + browser + judge all green). */
  passes: boolean;
  /** How many implement→evaluate cycles this feature has consumed (the per-feature
   *  stop guard — a feature that won't converge can't wedge the whole run). */
  attempts: number;
  /** Browser interaction steps that PROVE the feature works (clicked through the
   *  rendered app), proposed alongside the feature. Empty ⇒ a render smoke only. */
  steps?: IStep[];
  /** The last failing attempt's evaluator feedback (capped gate/judge output), fed
   *  into the NEXT attempt's implement prompt so the model fixes the actual errors
   *  instead of rebuilding blind. Cleared on a pass. */
  lastError?: string;
  /** True when all escalation rungs have been exhausted on this feature and the
   *  driver parked it for a later revisit pass. Transient during the build,
   *  persisted for resumption. */
  parked?: boolean;
  /** The structured handoff from the escalation ladder (ladder exhaustion).
   *  Includes the tried-lever history for seeding a revisit. Persisted with the
   *  feature so a second pass can retry without repeating the same levers. */
  handoff?: IHandoff;
}

/** A greenfield build's whole state: the one-line goal + the feature checklist. */
export interface IGreenfieldState {
  /** The one-line build goal (what the planner was asked to build). */
  goal: string;
  features: IFeature[];
}

/** The verdict for one feature after the layered evaluator runs. */
export interface IFeatureVerdict {
  passed: boolean;
  /** One-line reason (the failing layer's message, or a success note). */
  notes: string;
  /** Which layer decided it (for progress.md). Omitted on a pass. */
  stage?: "gate" | "browser" | "judge";
  /** Fuller (capped) failing output — the actual gate/judge errors — for feeding
   *  the next attempt so the model fixes real errors, not the one-line summary. */
  detail?: string;
}

export interface IGreenfieldResult {
  status: "done" | "stuck" | "needs-plan";
  features: IFeature[];
  /** When stuck: the feature that exhausted its attempts. */
  stuckFeature?: string;
}

/**
 * The two model-/tool-driven steps the outer loop delegates, injected so the loop
 * itself is pure and testable. `implement` makes the model build one feature;
 * `evaluate` runs the layered evaluator (gate → browser → judge) for it.
 */
export interface IGreenfieldDeps {
  /** Implement one feature. Returns the inner handoff when the escalation ladder
   *  is exhausted (feature parked), or undefined when proceeding normally or passing.
   *  Optionally accepts seeded tried-lever state (from a prior handoff.resume) to
   *  skip levers already tried in a revisit. */
  implement(
    feature: IFeature,
    state: IGreenfieldState,
    seed?: { triedLevers: string[] }
  ): Promise<{ handoff?: IHandoff }>;
  evaluate(
    feature: IFeature,
    state: IGreenfieldState
  ): Promise<IFeatureVerdict>;
  /** OPTIONAL last-resort escalation, tried ONCE before a feature parks as `stuck`:
   *  hand the failing file + its exact errors to a stronger "expert" model (the rung
   *  above the per-attempt feedback loop). Returns true when it applied a fix worth
   *  a final re-evaluation. Unset = no escalation — the generic path parks as before,
   *  so this is fully backward compatible. */
  rescue?(feature: IFeature, state: IGreenfieldState): Promise<boolean>;
}

export interface IGreenfieldOptions {
  onEvent?: Reporter;
}
