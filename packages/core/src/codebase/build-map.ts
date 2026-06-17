import { join, relative, dirname } from "node:path";
import { readFileSync } from "node:fs";
import type { TsService } from "../lsp";
import type { IStackProfile } from "../stack-detection";
import { fingerprint, gitHead } from "./staleness";
import { rankHubs } from "./rank-hubs";
import type { IWorkspaceMap, IWorkspaceModule } from "./codebase.types";

// Real entry points: main/app/server/cli anywhere, plus the top-level index —
// NOT every nested index.ts barrel (those are noise, not entry points).
const ENTRY_RE = /(^|\/)(main|app|server|cli)\.(ts|tsx)$/;
const TOP_INDEX_RE = /^(src\/)?index\.(ts|tsx)$/;
const MAX_ENTRY_POINTS = 12;
const CONVENTIONS_CHARS = 1500;

/**
 * Build a deterministic workspace map from the TS LanguageService — exports,
 * the internal import graph, and import-in-degree hubs. No LLM, no type-checking
 * beyond what `importsOf`/`exportedSymbols` already do.
 */
export async function buildWorkspaceMap(
  cwd: string,
  svc: TsService,
  stack: IStackProfile
): Promise<IWorkspaceMap> {
  const files = svc.projectFiles();
  const fileSet = new Set(files);
  const modules: Record<string, IWorkspaceModule> = {};

  for (const f of files) {
    modules[f] = buildModule(cwd, svc, f, fileSet);
  }

  const fp = fingerprint(cwd, files);
  const head = await gitHead(cwd);

  return {
    meta: {
      gitHead: head,
      sourceFingerprint: fp.combined,
      builtAt: new Date().toISOString(),
      totalFiles: files.length,
    },
    stack,
    entryPoints: files
      .filter((f) => ENTRY_RE.test(f) || TOP_INDEX_RE.test(f))
      .slice(0, MAX_ENTRY_POINTS),
    directoryTree: renderTree(files),
    modules,
    hubs: rankHubs(modules),
    conventions: readConventions(cwd),
    fileHashes: fp.perFile,
    staleFiles: [],
  };
}

function buildModule(
  cwd: string,
  svc: TsService,
  file: string,
  fileSet: Set<string>
): IWorkspaceModule {
  const text = readSafe(cwd, file);

  return {
    path: file,
    exports: svc.exportedSymbols(file).map((s) => s.name),
    imports: svc
      .importsOf(file)
      .map((abs) => relative(cwd, abs).replaceAll("\\", "/")),
    lineCount: text.length === 0 ? 0 : text.split("\n").length,
    hasTests: hasSiblingTest(file, fileSet),
  };
}

function hasSiblingTest(file: string, fileSet: Set<string>): boolean {
  if (/\.(test|spec)\.[tj]sx?$/.test(file)) {
    return true;
  }

  const sibling = file.replace(/\.([tj]sx?)$/, ".test.$1");

  return sibling !== file && fileSet.has(sibling);
}

function readSafe(cwd: string, file: string): string {
  try {
    return readFileSync(join(cwd, file), "utf8");
  } catch {
    return "";
  }
}

/** A condensed directory summary: each directory with its source-file count. */
function renderTree(files: string[]): string {
  const counts = new Map<string, number>();

  for (const f of files) {
    const dir = dirname(f);

    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, n]) => `${dir === "." ? "(root)" : dir}/ (${n})`)
    .join("\n");
}

function readConventions(cwd: string): string {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const text = readSafe(cwd, name);

    if (text.length > 0) {
      return text.slice(0, CONVENTIONS_CHARS);
    }
  }

  return "";
}
