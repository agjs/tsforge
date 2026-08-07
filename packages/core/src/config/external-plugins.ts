import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "../lib/guards";
import { registerExternalPack } from "../rule-packs";
import type { IRulePack } from "../rule-packs/rule-packs.types";
import { fingerprintPluginEntry } from "./plugin-fingerprint";

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

/** Deep-freeze a pack's rulesConfig (and the pack shell) so a live export
 *  cannot be mutated after registration to weaken severities under the same id. */
export function freezeRulePack(pack: IRulePack): IRulePack {
  const rulesConfig: Record<string, "error" | "warn"> = {};

  for (const [name, severity] of Object.entries(pack.rulesConfig)) {
    rulesConfig[name] = severity;
  }

  const rules: Record<string, IRulePack["rules"][string]> = {};

  // Freeze each rule MODULE, not just the key set: a plugin that keeps a
  // reference to its own exported rule could otherwise replace `create` with a
  // no-op after registration. The disk never changes, so the content fingerprint
  // cannot see that one — only the freeze can.
  for (const [name, rule] of Object.entries(pack.rules)) {
    rules[name] = Object.freeze(rule);
  }

  return Object.freeze({
    id: pack.id,
    description: pack.description,
    rules: Object.freeze(rules),
    rulesConfig: Object.freeze(rulesConfig),
  });
}

/** Absolute filesystem path for a plugin entry, when one exists. */
function resolvePluginEntryPath(pluginPath: string, cwd: string): string {
  if (pluginPath.startsWith(".") || isAbsolute(pluginPath)) {
    return resolve(cwd, pluginPath);
  }

  // Bare package specifier: best-effort resolve to a file path for hashing.
  try {
    return Bun.resolveSync(pluginPath, cwd);
  } catch {
    return resolve(cwd, pluginPath);
  }
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

/** A pack loaded from disk with the content fingerprint that freezes it. */
export interface ILoadedExternalPack {
  readonly pack: IRulePack;
  readonly entryPath: string;
  readonly fingerprint: string;
}

/**
 * Dynamically import each plugin and collect its valid exported rule packs.
 * Never throws — an unimportable module or an export that is not a valid pack is
 * reported and skipped, so a broken plugin can't take down a run.
 *
 * Each successful pack is paired with a content fingerprint of its entry file
 * and relative import graph so mid-session edits can be detected (F19).
 */
export async function loadExternalPacks(
  plugins: readonly IExternalPlugin[],
  cwd: string,
  report: (message: string) => void
): Promise<ILoadedExternalPack[]> {
  const out: ILoadedExternalPack[] = [];

  for (const plugin of plugins) {
    const entryPath = resolvePluginEntryPath(plugin.path, cwd);
    const specifier = plugin.path.startsWith(".")
      ? pathToFileURL(entryPath).href
      : plugin.path;

    let mod: unknown;
    let fingerprint: string;

    try {
      fingerprint = await fingerprintPluginEntry(entryPath);
      mod = await import(specifier);

      // Re-hash AFTER the module body ran. Content swapped in that window is
      // EXECUTED while the stored digest describes bytes that were never loaded —
      // and a plugin can do the swapping itself, at import. Every later check
      // would then compare against a phantom, so refuse the plugin outright.
      if ((await fingerprintPluginEntry(entryPath)) !== fingerprint) {
        report(
          `plugin '${plugin.path}' changed while loading — refusing to register it`
        );

        continue;
      }
    } catch (err) {
      report(`plugin '${plugin.path}' failed to load: ${errMessage(err)}`);

      continue;
    }

    if (!isRecord(mod)) {
      continue;
    }

    for (const candidate of candidateExports(mod, plugin.packs)) {
      if (isRulePack(candidate)) {
        const pack = freezeRulePack(candidate);

        out.push({ pack, entryPath, fingerprint });
        report(`plugin '${plugin.path}': loaded pack '${pack.id}'`);
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
 * Load every configured plugin, register its packs in the rule-pack registry
 * with a content freeze, and return the registered pack ids (to fold into the
 * active pack list). Never throws on a bad plugin; load failures are reported.
 */
export async function loadAndRegisterPlugins(
  plugins: readonly IExternalPlugin[],
  cwd: string,
  report: (message: string) => void
): Promise<string[]> {
  const loaded = await loadExternalPacks(plugins, cwd, report);
  const ids: string[] = [];

  for (const { pack, entryPath, fingerprint } of loaded) {
    registerExternalPack(pack, { entryPath, fingerprint });
    ids.push(pack.id);
  }

  return ids;
}
