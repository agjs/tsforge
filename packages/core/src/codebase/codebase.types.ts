import type { IStackProfile } from "../stack-detection";

export interface IWorkspaceMeta {
  /** Commit at build time, or "dirty"/"" when unavailable. */
  gitHead: string;
  /** Combined hash of all mapped files (quick fresh/stale equality check). */
  sourceFingerprint: string;
  /** ISO timestamp of the build. */
  builtAt: string;
  totalFiles: number;
}

export interface IWorkspaceModule {
  path: string;
  exports: string[];
  /** Resolved internal imports, relative to the workspace root. */
  imports: string[];
  lineCount: number;
  hasTests: boolean;
}

/** A module ranked by IMPORT IN-DEGREE — how many other modules import it. */
export interface IModuleHub {
  path: string;
  exports: string[];
  importedBy: number;
}

export interface IWorkspaceMap {
  meta: IWorkspaceMeta;
  stack: IStackProfile;
  entryPoints: string[];
  /** Condensed text tree of the source files. */
  directoryTree: string;
  modules: Record<string, IWorkspaceModule>;
  /** Sorted desc by importedBy. */
  hubs: IModuleHub[];
  /** AGENTS.md excerpt if present (else ""). */
  conventions: string;
  /** Per-file content hash, for staleness detection (not injected). */
  fileHashes: Record<string, string>;
  /** Files changed since the build (filled at recall, not persisted). */
  staleFiles: string[];
}
