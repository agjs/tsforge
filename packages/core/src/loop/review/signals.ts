import { isAbsolute, join, relative } from "node:path";
import type { TsService } from "../../lsp";

/** Top-level exported declaration names in a file (best-effort, text-based) —
 *  the symbols other code can depend on, hence the regression surface. */
const EXPORT_RE =
  /^export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

function exportedNames(text: string): string[] {
  const names = new Set<string>();

  for (const m of text.matchAll(EXPORT_RE)) {
    if (m[1] !== undefined) {
      names.add(m[1]);
    }
  }

  return [...names];
}

const MAX_CALLER_FILES = 5;
const MAX_CALLER_LINES = 3;

/**
 * A tool-derived signal: who CALLS the changed file's exports, computed
 * type-exactly from the TypeScript LanguageService (`impact`). Handed to the
 * reviewer so the regressions lens has concrete call sites to check instead of
 * having to guess them. Returns "" when there's no LanguageService (no tsconfig)
 * or the exports have no external callers.
 */
export async function callerSignal(
  svc: TsService | null,
  cwd: string,
  file: string
): Promise<string> {
  if (svc === null) {
    return "";
  }

  const abs = isAbsolute(file) ? file : join(cwd, file);
  const text = await Bun.file(abs)
    .text()
    .catch(() => "");

  if (text.length === 0) {
    return "";
  }

  const lines: string[] = [];

  for (const name of exportedNames(text)) {
    const sites = callersOf(svc, cwd, file, abs, name);

    if (sites.length > 0) {
      lines.push(`- ${name} → ${sites.join("; ")}`);
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
  name: string
): string[] {
  let pos: number | undefined;

  try {
    pos = svc.positionOfSymbol(file, name);
  } catch {
    return [];
  }

  if (pos === undefined) {
    return [];
  }

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
