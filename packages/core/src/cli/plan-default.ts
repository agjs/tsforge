import type { PolicyMode } from "../policy";

/** The args a plan-mode decision depends on (a structural subset of ICliArgs). */
export interface IPlanModeArgs {
  /** `--plan` — force plan mode on. */
  plan: boolean;
  /** `--no-plan` — force plan mode off (opt out of the default). */
  noPlan: boolean;
  /** `--policy-mode <mode>` — "" when unset. */
  policyMode: string;
}

/**
 * Whether a FRESH interactive REPL session should START in plan mode.
 *
 * tsforge is plan-first by default: a new session explores read-only, asks the
 * few clarifying questions that matter, and proposes a plan the user approves
 * before it writes anything. Precedence (first match wins):
 *   1. A RESUMED session restores its saved posture verbatim (the read-only
 *      guarantee must survive `--continue`).
 *   2. `--plan` forces it on.
 *   3. `--no-plan` forces it off.
 *   4. An explicit `--policy-mode <mode>` picks the posture directly — only
 *      "plan" enables plan mode; any other explicit mode opts out.
 *   5. Otherwise the resolved base mode reflects config `policy.mode` (or
 *      "default" when unset): a repo that opted into a specific autonomous
 *      posture ("acceptEdits", "ci", …) is honored; the bare "default" falls
 *      through to plan-first.
 *
 * This is applied ONLY in the interactive REPL. One-shot / headless / eval / CI
 * paths keep their autonomous behavior — plan mode needs a human to approve.
 *
 * `configuredMode` is the session's already-resolved base mode
 * (`Session.basePolicyMode`), so no project config re-load is needed here.
 */
export function resolveInitialPlanMode(
  args: IPlanModeArgs,
  resumedPlanMode: boolean | undefined,
  configuredMode: PolicyMode
): boolean {
  if (resumedPlanMode !== undefined) {
    return resumedPlanMode;
  }

  if (args.plan) {
    return true;
  }

  if (args.noPlan) {
    return false;
  }

  if (args.policyMode !== "") {
    return args.policyMode === "plan";
  }

  if (configuredMode !== "default") {
    return configuredMode === "plan";
  }

  return true;
}
