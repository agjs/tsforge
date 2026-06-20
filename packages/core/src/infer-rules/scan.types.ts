import type { IStackProfile } from "../stack-detection";
import type { IConventions } from "./conventions.types";

/** Interface-naming evidence: how many declared interfaces are `I`-prefixed vs
 *  bare PascalCase, with a few example names for the wizard's evidence block. */
export interface IInterfaceScan {
  readonly iPrefixed: number;
  readonly bare: number;
  readonly total: number;
  readonly iExamples: readonly string[];
  readonly bareExamples: readonly string[];
}

/** Enum evidence: how many files declare at least one `enum`. */
export interface IEnumScan {
  readonly fileCount: number;
}

/** Test-layout evidence: tests sitting beside their source vs in a `tests/` mirror. */
export interface ITestScan {
  readonly coLocated: number;
  readonly mirrored: number;
}

/** Frontend folder-layout evidence (presence signals, not counts). */
export interface IFolderScan {
  readonly views: boolean;
  readonly features: boolean;
  readonly flatComponents: boolean;
  readonly routeFolders: boolean;
}

/** Which config files the repo already ships (evidence only — never executed). */
export interface IToolingScan {
  readonly tsconfig: boolean;
  readonly eslint: boolean;
  readonly prettier: boolean;
}

/** The full read-only scan of a repository the wizard presents as evidence. */
export interface IScanReport {
  readonly stack: IStackProfile;
  readonly interfaces: IInterfaceScan;
  readonly enums: IEnumScan;
  readonly tests: ITestScan;
  readonly folders: IFolderScan;
  readonly tooling: IToolingScan;
  readonly filesScanned: number;
}

/** The conventions the scan RECOMMENDS (preselected in the wizard, written by
 *  `--yes`). Always a fully-resolved set. */
export interface IWizardDefaults {
  readonly conventions: IConventions;
}
