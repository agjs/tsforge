export * from "./self-harness.types";
export {
  activeOverlay,
  emptyOverlay,
  isEmptyPatch,
  mergeOverlay,
  modelSlug,
  overlayPathFor,
  parseOverlay,
  resetOverlayCache,
} from "./overlay";
export {
  resolveSplits,
  listCorpusTasks,
  DEFAULT_HELD_IN,
  DEFAULT_HELD_OUT,
} from "./split";
export { mineWeaknesses, dominantSignal, type IMinedRun } from "./mine";
export {
  evaluateHarness,
  type IEvaluateOptions,
  type IEvaluateOutcome,
} from "./evaluate";
export { propose, type IProposeOptions } from "./propose";
export {
  acceptanceDecision,
  validateCandidate,
  type HarnessEvaluator,
  type IEvaluationOutput,
  type IAcceptanceDecision,
} from "./validate";
export { runSelfHarness, type ISelfHarnessOptions } from "./loop";
export { emitReport, type IReport } from "./report";
