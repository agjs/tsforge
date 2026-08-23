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
export { ARCHETYPES, isArchetype } from "./scaffold.types";
export { parseManifest, loadBundledManifest } from "./boringstack-manifest";
export { loadPhaserTemplate } from "./phaser-manifest";
export { loadScaffoldSource } from "./scaffold-source";
export { readScaffoldArchetype, resolveScaffoldedWorkspace } from "./receipt";
export type { IScaffoldWorkspaceIo } from "./receipt";
export {
  applyPhaserIdentity,
  ensurePhaserCatalog,
  phaserPackageName,
} from "./apply-phaser";
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
export {
  runScaffold,
  gateCommand,
  scaffoldPhaseReporter,
  makeScaffoldRunDeps,
} from "./run-scaffold";
export type { IScaffoldDeps, IScaffoldOutcome } from "./run-scaffold";
export { realRunner, realFs, realPoller } from "./io";
export type { IScaffoldRunner, IScaffoldFs, IReadyPoller } from "./io";
export {
  PORT_ENV_KEYS,
  DEFAULT_HOST_PORTS,
  parseHostPortsEnv,
  readHostPorts,
  hostPortOr,
  remapUrlToHostPorts,
} from "./ports";
export type { PortEnvKey, HostPorts } from "./ports";
