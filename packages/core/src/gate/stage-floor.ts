import { TSC_STAGE_LABEL, TYPE_AWARE_STAGE_LABEL } from "./core-gate";

/**
 * The auto gate's MONOTONIC STAGE FLOOR. Packs already only accumulate
 * (gate-setup's resolver), but the gate's *stages* had no such floor: deleting
 * the root `tsconfig.json` silently dropped the tsc stage from the re-resolved
 * command, and deleting `package.json` collapsed the whole gate to the
 * workspace-container skip (`command: "true"`) — both let the code under test
 * weaken its own referee mid-drive. The floor records which stages a session's
 * gate has ever had; a re-resolution that LOSES one is a violation the runner
 * turns into a red gate result instead of a silent downgrade.
 *
 * Session-scoped by design (held in the resolver/runner closures, like the
 * packs accumulator): `--continue` and new sessions re-capture policy, so a
 * HUMAN intentionally restructuring the project has an escape hatch, while the
 * model can never relax the gate within a running drive. A manual `/gate`
 * override flips the auto gate off entirely and outranks the floor.
 */
export interface IGateStageFloor {
  readonly hadTsc: boolean;
  readonly hadTypeAware: boolean;
  readonly wasPackageGate: boolean;
}

export const EMPTY_STAGE_FLOOR: IGateStageFloor = {
  hadTsc: false,
  hadTypeAware: false,
  wasPackageGate: false,
};

/** Which floor-relevant stages a resolved gate label carries. The label is
 *  assembled from the exported stage-label constants in core-gate, so this
 *  can't string-drift from what buildGate actually emits. */
export function observeStageFloor(gateLabel: string): IGateStageFloor {
  return {
    hadTsc: gateLabel.includes(TSC_STAGE_LABEL),
    hadTypeAware: gateLabel.includes(TYPE_AWARE_STAGE_LABEL),
    // A per-package (non-container) gate — anything that isn't the container
    // skip. Callers set this from context; label-wise every real gate is one.
    wasPackageGate: true,
  };
}

/** Monotonic OR — a stage once present is on the floor forever (this session). */
export function raiseStageFloor(
  floor: IGateStageFloor,
  observed: IGateStageFloor
): IGateStageFloor {
  return {
    hadTsc: floor.hadTsc || observed.hadTsc,
    hadTypeAware: floor.hadTypeAware || observed.hadTypeAware,
    wasPackageGate: floor.wasPackageGate || observed.wasPackageGate,
  };
}

/** The explanation when `observed` falls below `floor`, or null when it holds.
 *  Names the vanished stage and the file whose deletion causes that shape, plus
 *  the human escape hatch. */
export function stageFloorViolation(
  floor: IGateStageFloor,
  observed: IGateStageFloor
): string | null {
  const lost: string[] = [];

  if (floor.hadTsc && !observed.hadTsc) {
    lost.push(
      `the "${TSC_STAGE_LABEL}" stage vanished (tsconfig.json/package.json ` +
        `removed or unreadable?)`
    );
  }

  if (floor.hadTypeAware && !observed.hadTypeAware) {
    lost.push(
      `the "${TYPE_AWARE_STAGE_LABEL}" stage vanished (tsconfig.json removed?)`
    );
  }

  if (lost.length === 0) {
    return null;
  }

  return (
    `gate integrity: ${lost.join("; ")}. The gate will not downgrade ` +
    `mid-session — restore the file(s), or start a new session / --continue ` +
    `(which re-captures the gate) if the restructuring is intentional.`
  );
}
