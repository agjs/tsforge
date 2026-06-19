import type { TsService } from "../lsp";
import type { IFileView } from "../lib/fs";
import { callerSignal } from "./review/signals";

/** Cap the files probed and the bundle size — a pre-edit primer, not a dump. */
const MAX_SCOUT_FILES = 8;
const SCOUT_CHARS = 4000;

/**
 * A DETERMINISTIC pre-edit context bundle: for each editable file that already
 * exists, who calls its exports (type-exact, from the TypeScript LanguageService).
 * Injected before the model edits brownfield code so it changes with blast-radius
 * awareness instead of blind. No model call — the divergence from Codebuff's LLM
 * file-picker. Returns "" when there's no tsconfig/service or nothing depends on
 * the targets (e.g. a from-scratch build).
 */
export function buildScoutContext(
  svc: TsService | null,
  cwd: string,
  editable: readonly IFileView[]
): string {
  if (svc === null) {
    return "";
  }

  const sections: string[] = [];

  for (const file of editable) {
    if (sections.length >= MAX_SCOUT_FILES) {
      break;
    }

    // A not-yet-created (empty) editable file has no callers to map.
    if (file.content.trim().length === 0) {
      continue;
    }

    const signal = callerSignal(svc, cwd, file.path);

    if (signal.length > 0) {
      sections.push(`${file.path}:\n${signal}`);
    }
  }

  if (sections.length === 0) {
    return "";
  }

  const bundle = `Blast radius — who calls the files you're about to change (type-exact; check these for regressions before editing):\n${sections.join("\n\n")}`;

  return bundle.slice(0, SCOUT_CHARS);
}
