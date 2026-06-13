import { resolve } from "node:path";
import { isRecord } from "../lib/guards";
import { registerExternalPack } from "../rule-packs";
import type { IRulePack } from "../rule-packs/rule-packs.types";

/** One external plugin entry from tsforge.config.json `plugins`. */
export interface IExternalPlugin {
  /** Module specifier or path (relative paths resolve against the repo root). */
  readonly path: string;
  /** Named exports to load as rule packs. Omit to load every exported pack. */
  readonly packs?: readonly string[];
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Type guard: a well-formed IRulePack (no `as` — every field is checked). */
export function isRulePack(value: unknown): value is IRulePack {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.id !== "string" || value.id.length === 0) {
    return false;
  }

  if (typeof value.description !== "string") {
    return false;
  }

  if (!isRecord(value.rules) || !isRecord(value.rulesConfig)) {
    return false;
  }

  for (const severity of Object.values(value.rulesConfig)) {
    if (severity !== "error" && severity !== "warn") {
      return false;
    }
  }

  return true;
}

/** Parse the `plugins` config field into validated entries. */
export function parsePlugins(raw: unknown): IExternalPlugin[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const plugins: IExternalPlugin[] = [];

  for (const item of raw) {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      item.path.length === 0
    ) {
      continue;
    }

    const packs = Array.isArray(item.packs)
      ? item.packs.filter((p): p is string => typeof p === "string")
      : undefined;

    plugins.push({
      path: item.path,
      ...(packs !== undefined && packs.length > 0 ? { packs } : {}),
    });
  }

  return plugins;
}

/** Collect the candidate exports to validate from a loaded module. */
function candidateExports(
  mod: Record<string, unknown>,
  names: readonly string[] | undefined
): unknown[] {
  if (names === undefined) {
    return Object.values(mod);
  }

  return names.map((name) => mod[name]);
}

/**
 * Dynamically import each plugin and collect its valid exported rule packs.
 * Never throws — an unimportable module or an export that is not a valid pack is
 * reported and skipped, so a broken plugin can't take down a run.
 */
export async function loadExternalPacks(
  plugins: readonly IExternalPlugin[],
  cwd: string,
  report: (message: string) => void
): Promise<IRulePack[]> {
  const out: IRulePack[] = [];

  for (const plugin of plugins) {
    const specifier = plugin.path.startsWith(".")
      ? resolve(cwd, plugin.path)
      : plugin.path;

    let mod: unknown;

    try {
      mod = await import(specifier);
    } catch (err) {
      report(`plugin '${plugin.path}' failed to load: ${errMessage(err)}`);

      continue;
    }

    if (!isRecord(mod)) {
      continue;
    }

    for (const candidate of candidateExports(mod, plugin.packs)) {
      if (isRulePack(candidate)) {
        out.push(candidate);
        report(`plugin '${plugin.path}': loaded pack '${candidate.id}'`);
      } else {
        report(
          `plugin '${plugin.path}': an export is not a valid rule pack — skipped`
        );
      }
    }
  }

  return out;
}

/**
 * Load every configured plugin, register its packs in the rule-pack registry,
 * and return the registered pack ids (to fold into the active pack list so the
 * gate runs them). Never throws.
 */
export async function loadAndRegisterPlugins(
  plugins: readonly IExternalPlugin[],
  cwd: string,
  report: (message: string) => void
): Promise<string[]> {
  const packs = await loadExternalPacks(plugins, cwd, report);
  const ids: string[] = [];

  for (const pack of packs) {
    registerExternalPack(pack);
    ids.push(pack.id);
  }

  return ids;
}
