import type { IWorkspaceModule, IModuleHub } from "./codebase.types";

/**
 * Rank modules by IMPORT IN-DEGREE — how many other modules import each one.
 * Computed by inverting the import graph (free; no per-symbol reference walks).
 * The most-imported modules are the hubs the agent should know about first.
 */
export function rankHubs(
  modules: Record<string, IWorkspaceModule>
): IModuleHub[] {
  const inDegree = new Map<string, number>();

  for (const m of Object.values(modules)) {
    for (const imp of m.imports) {
      inDegree.set(imp, (inDegree.get(imp) ?? 0) + 1);
    }
  }

  return Object.values(modules)
    .map((m) => ({
      path: m.path,
      exports: m.exports,
      importedBy: inDegree.get(m.path) ?? 0,
    }))
    .filter((h) => h.importedBy > 0)
    .sort((a, b) => b.importedBy - a.importedBy);
}
