/** Public surface of the greenfield scaffolding wizard. See scaffold.types.ts for
 *  the design overview (manifest as single source of truth, lives in boringstack). */
export type {
  IArchetype,
  IArchetypeProfile,
  IConfigCrossRule,
  IConfigField,
  IConfigFieldKind,
  IEnvEdit,
  IScaffoldAnswers,
  IScaffoldManifest,
  IScaffoldPlan,
} from "./scaffold.types";
export { parseManifest, loadBundledManifest } from "./boringstack-manifest";
export { parseScaffoldArgs } from "./scaffold-cli";
export type { IScaffoldCliOptions } from "./scaffold-cli";
export { answersToPlan } from "./plan";
export { coverageGaps, envKeysOf } from "./env-surface";
export { buildScaffoldSteps, stateToAnswers } from "./wizard";
export { scaffoldPreview } from "./preview";
export {
  applyEnvEdits,
  summarizeEnvEdits,
  applyScaffold,
  generateSecret,
} from "./configure";
export type { IConfigureDeps, IConfigureResult, IEnvWrite } from "./configure";
export { cloneRepo, scaffoldRecord } from "./clone";
export type { ICloneResult, IScaffoldRecord } from "./clone";
export { bootStack } from "./boot";
export type { IBootDeps, IBootResult } from "./boot";
export { runScaffold, gateCommand } from "./run-scaffold";
export type { IScaffoldDeps, IScaffoldOutcome } from "./run-scaffold";
export { realRunner, realFs, realPoller } from "./io";
export type { IScaffoldRunner, IScaffoldFs, IReadyPoller } from "./io";
