import type { IStep } from "../../browser";
import type { Reporter } from "../loop.types";

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
}

export interface IGreenfieldResult {
  status: "done" | "stuck";
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
  implement(feature: IFeature, state: IGreenfieldState): Promise<void>;
  evaluate(
    feature: IFeature,
    state: IGreenfieldState
  ): Promise<IFeatureVerdict>;
}

export interface IGreenfieldOptions {
  /** Give up on a feature after this many implement→evaluate cycles (default 3). */
  maxAttemptsPerFeature?: number;
  onEvent?: Reporter;
}
