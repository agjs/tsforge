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

/** Fingerprint each plugin entry was IMPORTED at in this process, so a reload of
 *  changed content can be refused rather than served from the ESM cache. */
const IMPORTED_AT = new Map<string, string>();

/** Freeze an object and everything reachable from it. Cycles are handled via
 *  `seen`; functions are left alone (a rule's `create` cannot be reassigned once
 *  its owner is frozen, and freezing the function object itself buys nothing). */
function deepFreeze(value: unknown, seen: Set<object>): void {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }

  seen.add(value);
  Object.freeze(value);

  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
}

/** Deep-freeze a pack's rulesConfig (and the pack shell) so a live export
 *  cannot be mutated after registration to weaken severities under the same id. */
export function freezeRulePack(pack: IRulePack): IRulePack {
  const rulesConfig: Record<string, "error" | "warn"> = {};

  // Re-validate as we copy. `isRulePack` checked an EARLIER read of the same
  // plugin-controlled object, and a property defined as a getter can answer the
  // validator and the copy differently — registering a pack weaker than the one
  // that passed, with no on-disk change for the fingerprint to catch. This read
  // is the one that becomes the frozen pack, so it is the one that must hold.
  // Read through a widened view: the declared `"error" | "warn"` describes what
  // the validator SAW, and a getter is under no obligation to say it twice, so
  // the type here is a claim about untrusted state rather than a guarantee.
  const declared: Record<string, unknown> = pack.rulesConfig;

  for (const [name, severity] of Object.entries(declared)) {
    if (severity !== "error" && severity !== "warn") {
      throw new Error(
        `tsforge: rule pack '${pack.id}' reported severity '${String(severity)}' for '${name}' after validation — refusing a pack whose configuration changes between reads.`
      );
    }

    rulesConfig[name] = severity;
  }

  const rules: Record<string, IRulePack["rules"][string]> = {};

  // Freeze each rule MODULE and everything under it, not just the key set: a
  // plugin that keeps a reference to its own exported rule could otherwise
  // replace `create` with a no-op, rewrite a `meta.messages` entry, or widen
  // `meta.schema` after registration. The disk never changes in any of those
  // cases, so the content fingerprint cannot see them — only the freeze can.
  for (const [name, rule] of Object.entries(pack.rules)) {
    deepFreeze(rule, new Set());
    rules[name] = rule;
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
  /** The `plugins[].path` this pack came from, so a caller can tell which
   *  configured entries produced nothing. */
  readonly source: string;
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

    let mod: unknown;
    let fingerprint: string;

    try {
      fingerprint = await fingerprintPluginEntry(entryPath);

      // A second load of an entry whose content changed cannot be honored: the
      // ESM cache is keyed by resolved path and Bun ignores query strings, so
      // `import` returns the module from the FIRST load. Registering it would
      // pair a stale module with a fresh digest — a pack whose rules and whose
      // freeze describe different content, which no later check can detect.
      const importedAt = IMPORTED_AT.get(entryPath);

      if (importedAt !== undefined && importedAt !== fingerprint) {
        report(
          `plugin '${plugin.path}' changed since it was first loaded in this process — restart the session to pick it up`
        );

        continue;
      }

      // Import the file that was HASHED, not the specifier: a bare specifier
      // re-resolved at import time can select a different file than the one the
      // fingerprint pinned.
      mod = await import(pathToFileURL(entryPath).href);

      IMPORTED_AT.set(entryPath, fingerprint);

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
        let pack: IRulePack;

        try {
          pack = freezeRulePack(candidate);
        } catch (err) {
          report(`plugin '${plugin.path}': ${errMessage(err)}`);

          continue;
        }

        out.push({ pack, entryPath, fingerprint, source: plugin.path });
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
 * active pack list).
 *
 * THROWS when a configured plugin produced no pack. The details of why are
 * reported by `loadExternalPacks`; what matters here is that the run does not
 * continue. Starting anyway means running with fewer rules than the config asks
 * for, announced only by a line of report output — a gate quietly weaker than
 * the one the project declared, which is the same failure the content freeze
 * exists to prevent, reached from the other side.
 */
export async function loadAndRegisterPlugins(
  plugins: readonly IExternalPlugin[],
  cwd: string,
  report: (message: string) => void
): Promise<string[]> {
  const loaded = await loadExternalPacks(plugins, cwd, report);
  const empty = plugins
    .map((p) => p.path)
    .filter((path) => !loaded.some((l) => l.source === path));

  // Decided BEFORE anything is registered. The registry is global, so throwing
  // after a partial registration leaves the rule set half-applied behind an
  // error saying the load failed — and a caller that catches it then runs with
  // packs the failure was supposed to have prevented.
  if (empty.length > 0) {
    throw new Error(
      `tsforge: configured plugin(s) registered no rule pack: ${empty.join(", ")}. See the plugin load messages above for why. Refusing to run with a weaker rule set than tsforge.config.json declares.`
    );
  }

  const ids: string[] = [];

  for (const { pack, entryPath, fingerprint } of loaded) {
    registerExternalPack(pack, { entryPath, fingerprint });
    ids.push(pack.id);
  }

  return ids;
}
