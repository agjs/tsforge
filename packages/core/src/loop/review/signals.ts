import { isAbsolute, join, relative } from "node:path";
import type { TsService } from "../../lsp";

const MAX_CALLER_FILES = 5;
const MAX_CALLER_LINES = 3;

/**
 * A tool-derived signal: who CALLS the changed file's exports, computed
 * type-exactly from the TypeScript LanguageService (`impact`). Handed to the
 * reviewer so the regressions lens has concrete call sites to check instead of
 * having to guess them. Returns "" when there's no LanguageService (no tsconfig)
 * or the exports have no external callers.
 */
export function callerSignal(
  svc: TsService | null,
  cwd: string,
  file: string
): string {
  if (svc === null) {
    return "";
  }

  const abs = isAbsolute(file) ? file : join(cwd, file);
  const lines: string[] = [];

  for (const sym of svc.exportedSymbols(file)) {
    const sites = callersOf(svc, cwd, file, abs, sym.pos);

    if (sites.length > 0) {
      lines.push(`- ${sym.name} → ${sites.join("; ")}`);
    }
  }

  return lines.join("\n");
}

/** External call sites of one exported symbol, as `path:line,line` strings. */
function callersOf(
  svc: TsService,
  cwd: string,
  file: string,
  abs: string,
  pos: number
): string[] {
  let external: { file: string; lines: number[] }[];

  try {
    external = svc.impact(file, pos).files.filter((f) => f.file !== abs);
  } catch {
    return [];
  }

  return external
    .slice(0, MAX_CALLER_FILES)
    .map(
      (f) =>
        `${relative(cwd, f.file)}:${f.lines.slice(0, MAX_CALLER_LINES).join(",")}`
    );
}
