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

export interface IGreenfieldResult {
  status: "done" | "stuck" | "needs-plan";
  features: IFeature[];
  /** When stuck: the feature that exhausted its attempts. */
  stuckFeature?: string;
}

/**
 * The single model-/tool-driven step the outer loop delegates, injected so the loop
 * itself is pure and testable. `implement` builds the feature AND runs the gate loop
 * (escalation ladder) internally; it returns whether it finished or parked.
 */
export interface IGreenfieldDeps {
  /** Implement one feature with the internal escalation ladder. Returns {done: true}
   *  when the feature passes all gates and is ready to ship; {done: false, handoff}
   *  when the ladder is exhausted and the feature is parked for later. The handoff
   *  carries the try-lever history for a revisit pass to seed a different tack.
   *  Optionally accepts seeded tried-lever state (from a prior handoff.resume) to
   *  skip levers already tried in a revisit. */
  implement(
    feature: IFeature,
    state: IGreenfieldState,
    seed?: { triedLevers: Array<import("../loop.types").EscalationRung> }
  ): Promise<{ done: boolean; handoff?: IHandoff }>;
}

export interface IGreenfieldOptions {
  onEvent?: Reporter;
}
