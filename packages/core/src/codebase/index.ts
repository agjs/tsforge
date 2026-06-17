import { join } from "node:path";
import { existsSync } from "node:fs";
import { TsService } from "../lsp";
import { detectStack } from "../stack-detection";
import { buildWorkspaceMap } from "./build-map";
import { serializeMapBlock } from "./serialize";
import { staleFiles } from "./staleness";
import type { IWorkspaceMap } from "./codebase.types";

export type { IWorkspaceMap, IModuleHub } from "./codebase.types";
export { serializeMapBlock } from "./serialize";

const MAP_DIR = ".tsforge";
const MAP_FILE = "workspace-map.json";

function mapPath(cwd: string): string {
  return join(cwd, MAP_DIR, MAP_FILE);
}

/** Build the workspace map and persist it under `.tsforge/`. Returns null when
 *  the project has no tsconfig (nothing to map deterministically). */
export async function buildAndPersistMap(
  cwd: string
): Promise<IWorkspaceMap | null> {
  if (!existsSync(join(cwd, "tsconfig.json"))) {
    return null;
  }

  const stack = await detectStack(cwd);
  const map = await buildWorkspaceMap(cwd, new TsService(cwd), stack);

  await Bun.write(mapPath(cwd), `${JSON.stringify(map, null, 2)}\n`);
  await ensureIgnored(cwd);

  return map;
}

/** Read the persisted map, or null if none / unreadable. */
export async function loadMap(cwd: string): Promise<IWorkspaceMap | null> {
  const file = Bun.file(mapPath(cwd));

  if (!(await file.exists())) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(await file.text());

    return isWorkspaceMap(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The system-prompt block for a session: load the persisted map, mark which
 * files drifted since it was built (cheap; no rebuild — keeps session start
 * fast), and serialize. Returns "" when the workspace was never mapped.
 */
export async function recallMapBlock(cwd: string): Promise<string> {
  const map = await loadMap(cwd);

  if (map === null) {
    return "";
  }

  map.staleFiles = staleFiles(cwd, map);

  return serializeMapBlock(map);
}

/** One-line status for `/map status`. */
export async function mapStatus(cwd: string): Promise<string> {
  const map = await loadMap(cwd);

  if (map === null) {
    return "no workspace map — run /map to build one";
  }

  const stale = staleFiles(cwd, map);
  const head = map.meta.gitHead.length > 0 ? map.meta.gitHead.slice(0, 7) : "?";

  return (
    `map: ${map.meta.totalFiles} files, ${map.hubs.length} hubs, ` +
    `built ${map.meta.builtAt} @ ${head}, ${stale.length} changed since`
  );
}

/** Delete the persisted map. */
export async function forgetMap(cwd: string): Promise<boolean> {
  const file = Bun.file(mapPath(cwd));

  if (!(await file.exists())) {
    return false;
  }

  await file.delete();

  return true;
}

function isWorkspaceMap(value: unknown): value is IWorkspaceMap {
  return (
    typeof value === "object" &&
    value !== null &&
    "meta" in value &&
    "modules" in value &&
    "hubs" in value
  );
}

/** Append the map artifact to `.tsforge/.gitignore` (machine-specific). */
async function ensureIgnored(cwd: string): Promise<void> {
  const file = Bun.file(join(cwd, MAP_DIR, ".gitignore"));
  const current = (await file.exists()) ? await file.text() : "";

  if (current.split("\n").includes(MAP_FILE)) {
    return;
  }

  await Bun.write(
    join(cwd, MAP_DIR, ".gitignore"),
    `${current.replace(/\n*$/u, current.length > 0 ? "\n" : "")}${MAP_FILE}\n`
  );
}
