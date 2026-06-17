import type { IWorkspaceMap, IModuleHub } from "./codebase.types";

const MAX_HUBS = 15;
const MAX_HUB_EXPORTS = 8;
const MODULE_BUDGET_CHARS = 6000;
const MAX_CONVENTIONS = 800;

/**
 * Render the workspace map as the single block injected into the system prompt.
 * Budget-trimmed: hubs and a module list ordered by import in-degree, dropping
 * the least-imported modules first so a small model's context isn't starved.
 */
export function serializeMapBlock(map: IWorkspaceMap): string {
  const lines = [
    "WORKSPACE_MAP:",
    `stack: ${map.stack.name} (${map.stack.confidence})`,
  ];

  if (map.entryPoints.length > 0) {
    lines.push(`entry points: ${map.entryPoints.join(", ")}`);
  }

  lines.push("", "directories:", map.directoryTree);

  if (map.hubs.length > 0) {
    lines.push("", "hubs (most-imported modules):");

    for (const h of map.hubs.slice(0, MAX_HUBS)) {
      lines.push(
        `  ${h.path} ←${h.importedBy} — exports: ${h.exports.slice(0, MAX_HUB_EXPORTS).join(", ")}`
      );
    }
  }

  const modules = renderModules(map);

  if (modules.length > 0) {
    lines.push("", "modules:", modules);
  }

  if (map.conventions.length > 0) {
    lines.push("", "conventions:", map.conventions.slice(0, MAX_CONVENTIONS));
  }

  lines.push("", staleNote(map));

  return lines.join("\n");
}

/** Module lines ordered by in-degree, accumulated until the char budget. */
function renderModules(map: IWorkspaceMap): string {
  const rank = new Map<string, number>(
    map.hubs.map((h: IModuleHub) => [h.path, h.importedBy])
  );
  const ordered = Object.values(map.modules).sort(
    (a, b) => (rank.get(b.path) ?? 0) - (rank.get(a.path) ?? 0)
  );

  const out: string[] = [];
  let used = 0;
  let dropped = 0;

  for (const m of ordered) {
    const line =
      m.exports.length > 0
        ? `  ${m.path} (${m.lineCount}) — exports: ${m.exports.join(", ")}`
        : `  ${m.path} (${m.lineCount})`;

    if (used + line.length > MODULE_BUDGET_CHARS) {
      dropped += 1;
      continue;
    }

    out.push(line);
    used += line.length + 1;
  }

  if (dropped > 0) {
    out.push(`  … ${dropped} more module(s) — use search / read on demand`);
  }

  return out.join("\n");
}

function staleNote(map: IWorkspaceMap): string {
  const n = map.staleFiles.length;
  const drift = n > 0 ? `${n} file(s) changed since` : "no changes since";

  return `Map built ${map.meta.builtAt}; ${drift}. For live symbols/refs use symbol_search / find_references.`;
}
