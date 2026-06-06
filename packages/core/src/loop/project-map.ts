import { LOOP_LIMITS } from "./loop.constants";
import type { IFileView } from "../lib/fs";

/** Exported symbol names in a file (lightweight regex — for the project map). */
export function exportedSymbols(content: string): string[] {
  const names = new Set<string>();
  const decl =
    /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;

  for (const m of content.matchAll(decl)) {
    if (m[1] !== undefined) {
      names.add(m[1]);
    }
  }

  for (const m of content.matchAll(/export\s*\{([^}]*)\}/g)) {
    const inner = m[1];

    if (inner === undefined) {
      continue;
    }

    for (const part of inner.split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();

      if (name !== undefined && name.length > 0) {
        names.add(name);
      }
    }
  }

  return [...names];
}

/** A compact map: `path (N lines) — exports: A, B`, one per file. */
function projectMap(views: readonly IFileView[]): string {
  return views
    .map((v) => {
      const lines = v.content.split("\n").length;
      const ex = exportedSymbols(v.content);

      return `  ${v.path} (${String(lines)} lines)${ex.length > 0 ? ` — exports: ${ex.join(", ")}` : ""}`;
    })
    .join("\n");
}

/**
 * Render a set of files for the prompt: full contents when small, a navigable
 * MAP when the combined size exceeds LOOP_LIMITS.mapThresholdChars (the model then
 * uses read/search/symbol_search to inspect specifics). Exported for testing.
 */
export function renderFileSection(views: readonly IFileView[]): {
  text: string;
  mapped: boolean;
} {
  const total = views.reduce((n, v) => n + v.content.length, 0);

  if (total > LOOP_LIMITS.mapThresholdChars) {
    return { text: projectMap(views), mapped: true };
  }

  return {
    text: views.map((v) => `File ${v.path}:\n${v.content}`).join("\n\n"),
    mapped: false,
  };
}
