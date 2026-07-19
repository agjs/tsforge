import type { ILoopState } from "./turn";
import type { EscalationRung } from "./loop.types";

/** Type guard to validate a string is a valid EscalationRung. */
function isValidRung(v: unknown): v is EscalationRung {
  return typeof v === "string" && ["R1", "R2", "R3", "R4"].includes(v);
}

/** Serializable representation of ILoopState (Map/Set → entries[]/array). */
interface ILoopStateDTO {
  prevGateErrors: ILoopState["prevGateErrors"];
  gateNoProgress: number;
  bestErrorCount: number;
  noNewLow: number;
  errorAge: [string, number][];
  lastGateCount: number;
  edits: number;
  regressions: number;
  ttsrInterrupts: number;
  steerLevel: number;
  pendingSteer?: string;
  resetContext?: boolean;
  pushedGuides?: string[];
  conventionsEnabled?: boolean;
  redGates?: number;
  plateauBest?: number;
  blockFingerprint?: string;
  recentGateFingerprints?: string[];
  triedLeversByBlock?: [string, string[]][];
  pendingRung?: string | null;
  pendingBlockFingerprint?: string | null;
  pendingDiagnosisSteer?: string | null;
  focusError?: string | null;
  pendingModelOverride?: ILoopState["pendingModelOverride"] | null;
}

/** Convert ILoopState to a JSON-serializable DTO (Map → entries[], Set → array). */
export function serializeLoopState(state: ILoopState): ILoopStateDTO {
  // WS-B: `nearGreenCheckpoint` / `nearGreenBest` / `nearGreenRollbacks` are deliberately NOT
  // persisted (and reset per drive anyway). The
  // checkpoint holds a full scope-file snapshot (potentially MBs of content) — too heavy to
  // write into every session record — and it is cheap, transient protection. A resumed
  // session re-establishes it on its FIRST near-green cycle: settleGate's `needsReArm`
  // (checkpoint === undefined) forces a fresh snapshot even when the resumed count is not a
  // new low, so protection is not lost across resume. Persisting a partial checkpoint (count
  // without the snapshot) would be worse — a rollback with nothing to restore.
  const errorAgeEntries: [string, number][] = Array.from(
    state.errorAge.entries()
  );

  const triedLeversByBlockEntries: [string, string[]][] =
    state.triedLeversByBlock
      ? Array.from(state.triedLeversByBlock.entries()).map(([fp, rungs]) => [
          fp,
          Array.from(rungs),
        ])
      : [];

  const pushedGuidesArray: string[] = state.pushedGuides
    ? Array.from(state.pushedGuides)
    : [];

  return {
    prevGateErrors: state.prevGateErrors,
    gateNoProgress: state.gateNoProgress,
    bestErrorCount: state.bestErrorCount,
    noNewLow: state.noNewLow,
    errorAge: errorAgeEntries,
    lastGateCount: state.lastGateCount,
    edits: state.edits,
    regressions: state.regressions,
    ttsrInterrupts: state.ttsrInterrupts,
    steerLevel: state.steerLevel,
    pendingSteer: state.pendingSteer,
    resetContext: state.resetContext,
    pushedGuides: pushedGuidesArray,
    conventionsEnabled: state.conventionsEnabled,
    redGates: state.redGates,
    plateauBest: state.plateauBest,
    blockFingerprint: state.blockFingerprint,
    recentGateFingerprints: state.recentGateFingerprints,
    triedLeversByBlock: triedLeversByBlockEntries,
    pendingRung: state.pendingRung,
    pendingBlockFingerprint: state.pendingBlockFingerprint,
    pendingDiagnosisSteer: state.pendingDiagnosisSteer,
    focusError: state.focusError,
    pendingModelOverride: state.pendingModelOverride,
  };
}

/** Reconstruct ILoopState from a DTO (entries[] → Map, array → Set). */
export function deserializeLoopState(dto: ILoopStateDTO): ILoopState {
  const errorAge = new Map<string, number>(dto.errorAge);

  const triedLeversByBlock = new Map<string, Set<EscalationRung>>();

  if (dto.triedLeversByBlock) {
    for (const [fp, rungs] of dto.triedLeversByBlock) {
      // Validate each rung string and collect into a typed Set
      const validRungs: EscalationRung[] = [];

      for (const r of rungs) {
        if (isValidRung(r)) {
          validRungs.push(r);
        }
      }

      if (validRungs.length > 0) {
        triedLeversByBlock.set(fp, new Set(validRungs));
      }
    }
  }

  const pushedGuides = dto.pushedGuides ? new Set(dto.pushedGuides) : undefined;

  // Build the state object with proper types
  const state: ILoopState = {
    prevGateErrors: dto.prevGateErrors,
    gateNoProgress: dto.gateNoProgress,
    bestErrorCount: dto.bestErrorCount,
    noNewLow: dto.noNewLow,
    errorAge,
    lastGateCount: dto.lastGateCount,
    edits: dto.edits,
    regressions: dto.regressions,
    ttsrInterrupts: dto.ttsrInterrupts,
    steerLevel: dto.steerLevel,
    pendingSteer: dto.pendingSteer,
    resetContext: dto.resetContext,
    pushedGuides,
    conventionsEnabled: dto.conventionsEnabled,
    redGates: dto.redGates,
    plateauBest: dto.plateauBest,
    blockFingerprint: dto.blockFingerprint,
    recentGateFingerprints: dto.recentGateFingerprints,
    triedLeversByBlock:
      triedLeversByBlock.size > 0 ? triedLeversByBlock : undefined,
    pendingRung: isValidRung(dto.pendingRung) ? dto.pendingRung : null,
    pendingBlockFingerprint: dto.pendingBlockFingerprint,
    pendingDiagnosisSteer: dto.pendingDiagnosisSteer,
    focusError: dto.focusError,
    pendingModelOverride: dto.pendingModelOverride,
  };

  return state;
}
