import { Glob } from "bun";
import { resolve } from "node:path";
import type { IArchitecture, ISubsystem } from "./architecture.types";
import { analyzeImports, subsystemOf } from "./dependency-analyzer";
import { findEntryPoints, findSeams } from "./entry-points";
import { fanIn, fanOut, findMutualCycles } from "./subsystem-graph";
import { entryFor, validateRegistry } from "./subsystem-registry";

export type {
  IArchitecture,
  ICycle,
  IEdge,
  IEntryPoint,
  IExternalImport,
  ISeam,
  ISubsystem,
  ISubsystemEntry,
  SubsystemTier,
} from "./architecture.types";
export { renderArchitectureMd } from "./serializer";
export {
  MERMAID_RESERVED,
  mermaidBlocks,
  reservedNodeIds,
  safeNodeId,
} from "./mermaid";
export {
  SUBSYSTEM_REGISTRY,
  entryFor,
  validateRegistry,
} from "./subsystem-registry";
export {
  analyzeImports,
  resolveSpecifier,
  subsystemOf,
  ROOT_ID,
} from "./dependency-analyzer";
export { fanIn, fanOut, findMutualCycles } from "./subsystem-graph";
export { findEntryPoints, findSeams, SEAM_NAMES } from "./entry-points";

/**
 * Read every `.ts` file under `srcRoot`, keyed by absolute path.
 *
 * Read once and shared by every pass — the analyzer, the entry-point scan and the
 * seam scan all need the same text, and re-reading 540 files three times is the
 * difference between a generator someone runs and one they skip.
 */
export async function readSources(
  srcRoot: string
): Promise<Map<string, string>> {
  const sources = new Map<string, string>();

  for await (const rel of new Glob("**/*.ts").scan(srcRoot)) {
    const path = resolve(srcRoot, rel);

    sources.set(path, await Bun.file(path).text());
  }

  return sources;
}

/** Derive the whole architecture map from a source tree. */
export async function buildArchitecture(
  srcRoot: string
): Promise<IArchitecture> {
  const sources = await readSources(srcRoot);
  const paths = [...sources.keys()];

  const files = new Map<string, number>();
  const lines = new Map<string, number>();

  for (const [path, text] of sources) {
    const id = subsystemOf(srcRoot, path);

    if (id === null) {
      continue;
    }

    files.set(id, (files.get(id) ?? 0) + 1);
    lines.set(id, (lines.get(id) ?? 0) + text.split("\n").length);
  }

  validateRegistry([...files.keys()]);

  const { edges, externals } = await analyzeImports(srcRoot, paths);
  const incoming = fanIn(edges);
  const outgoing = fanOut(edges);

  const subsystems: ISubsystem[] = [...files.keys()]
    .map((id) => {
      const entry = entryFor(id);

      return {
        id,
        purpose: entry.purpose,
        tier: entry.tier,
        files: files.get(id) ?? 0,
        lines: lines.get(id) ?? 0,
        fanIn: incoming.get(id) ?? 0,
        fanOut: outgoing.get(id) ?? 0,
      };
    })
    .sort((a, b) => b.lines - a.lines);

  return {
    subsystems,
    edges,
    cycles: findMutualCycles(edges),
    entryPoints: findEntryPoints(srcRoot, sources),
    seams: findSeams(srcRoot, sources),
    externals,
    totalFiles: paths.length,
    totalLines: [...lines.values()].reduce((sum, n) => sum + n, 0),
  };
}
