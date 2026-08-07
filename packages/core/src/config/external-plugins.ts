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

/** Marks an entry whose module RAN but was rejected. Not a digest — no content
 *  can produce it — so the entry can never match a later load. */
const REFUSED = "refused";

/** Fingerprint each plugin entry was IMPORTED at in this process, so a reload of
 *  changed content can be refused rather than served from the ESM cache. */
const IMPORTED_AT = new Map<string, string>();

/**
 * Copy a plugin value into frozen plain data, reading every property once.
 *
 * Freezing the plugin's own object in place does not do this job. `Object.freeze`
 * on an accessor property makes it non-configurable and leaves the getter
 * running, so `rules["no-foo"].create` can still answer ESLint with a different
 * function on every read — and the disk never changes, so no fingerprint sees
 * it. Freezing in place also reaches whatever the plugin's objects happen to
 * reference: a shared constant, a library object from `@typescript-eslint/utils`,
 * any singleton it imported. Those belong to someone else.
 *
 * Functions are kept by reference (a rule's `create` IS the implementation);
 * everything else becomes ours.
 */
function materialize(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const already = seen.get(value);

  if (already !== undefined) {
    return already;
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];

    seen.set(value, copy);

    for (const item of value) {
      copy.push(materialize(item, seen));
    }

    return Object.freeze(copy);
  }

  // Anything that is not a plain object — a RegExp in a schema, a Map, a Date,
  // an instance of the plugin's own class — is kept as it is. Rebuilding one
  // property-by-property does not reproduce it: the prototype goes, and with it
  // every method, leaving `{}` where ESLint expected a working object. These are
  // leaves in practice, and a leaf we pass through is a smaller risk than a
  // silently broken rule.
  const proto: unknown = Object.getPrototypeOf(value);

  if (proto !== Object.prototype && proto !== null) {
    return value;
  }

  const copy: Record<string | symbol, unknown> = {};

  seen.set(value, copy);

  // Every own key, not just the enumerable string ones: a property defined with
  // `Object.defineProperty` or under a symbol is still a property ESLint may
  // read, and dropping it silently changes the rule.
  for (const key of Reflect.ownKeys(value)) {
    copy[key] = materialize(Reflect.get(value, key), seen);
  }

  return Object.freeze(copy);
}

/** Freeze a pack so a live export cannot be mutated after registration to weaken
 *  severities under the same id. Packs coming from `loadExternalPacks` have
 *  already been materialized by `snapshotPack`; this stays for callers holding a
 *  pack from somewhere else, and is a no-op on an already-frozen copy. */
export function freezeRulePack(pack: IRulePack): IRulePack {
  const rulesConfig: Record<string, "error" | "warn"> = {};

  for (const [name, severity] of Object.entries(pack.rulesConfig)) {
    rulesConfig[name] = severity;
  }

  const rules: Record<string, IRulePack["rules"][string]> = {};

  for (const [name, rule] of Object.entries(pack.rules)) {
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

/**
 * Materialize a plugin export into plain data, reading each property ONCE.
 *
 * Validation and the freeze are two reads of the same object, and a property
 * defined as a getter is under no obligation to answer them the same way: a pack
 * can show `"error"` to the validator and `"warn"` to the copy that gets
 * registered, weakening itself with no on-disk change for the fingerprint to
 * catch. Checking the second read only narrows that to severities that are
 * INVALID. Reading once removes the second read instead — whatever the plugin
 * says first is what is validated, frozen, and enforced.
 */
function snapshotPack(value: unknown): unknown {
  return materialize(value, new Map());
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

/** The candidate exports to validate, paired with the name each came from so a
 *  failure can say WHICH export it was about. */
function candidateExports(
  mod: Record<string, unknown>,
  names: readonly string[] | undefined
): [string, unknown][] {
  if (names === undefined) {
    return Object.entries(mod);
  }

  return names.map((name) => [name, mod[name]]);
}

/** A pack loaded from disk with the content fingerprint that freezes it. */
export interface ILoadedExternalPack {
  readonly pack: IRulePack;
  readonly entryPath: string;
  readonly fingerprint: string;
  /** The `plugins[].path` this pack came from, so a caller can tell which
   *  configured entries produced nothing. */
  readonly source: string;
  /** The export name it was loaded from, so a caller can tell which DECLARED
   *  pack names produced nothing. */
  readonly exportName: string;
}

/**
 * Import one plugin entry and prove the bytes that ran are the bytes that were
 * hashed. Returns undefined — after reporting why — when it cannot be trusted.
 */
async function importVerified(
  plugin: IExternalPlugin,
  entryPath: string,
  report: (message: string) => void
): Promise<{ mod: unknown; fingerprint: string } | undefined> {
  try {
    const fingerprint = await fingerprintPluginEntry(entryPath);
    // A second load of an entry whose content changed cannot be honored: the
    // ESM cache is keyed by resolved path and Bun ignores query strings, so
    // `import` returns the module from the FIRST load. Registering it would
    // pair a stale module with a fresh digest — a pack whose rules and whose
    // freeze describe different content, which no later check can detect.
    const importedAt = IMPORTED_AT.get(entryPath);

    if (
      importedAt === REFUSED ||
      (importedAt !== undefined && importedAt !== fingerprint)
    ) {
      report(
        `plugin '${plugin.path}' cannot be loaded again in this process — restart tsforge to pick up plugin changes`
      );

      return undefined;
    }

    // Import the file that was HASHED, not the specifier: a bare specifier
    // re-resolved at import time can select a different file than the one the
    // fingerprint pinned.
    const mod: unknown = await import(pathToFileURL(entryPath).href);

    // Poisoned the instant the module RUNS, and cleared only once every check
    // below has passed. From here on the ESM cache holds this module for the
    // life of the process, so any exit that is not a clean success — a mismatch,
    // or a re-hash that THROWS because the entry was deleted or outgrew the
    // limits — must leave the entry unloadable. Marking it in the failure
    // branches instead means the throw paths miss it, and restoring the original
    // bytes then re-admits the cached module.
    IMPORTED_AT.set(entryPath, REFUSED);

    // Re-hash AFTER the module body ran. Content swapped in that window is
    // EXECUTED while the stored digest describes bytes that were never loaded —
    // and a plugin can do the swapping itself, at import. Every later check
    // would then compare against a phantom, so refuse the plugin outright.
    if ((await fingerprintPluginEntry(entryPath)) !== fingerprint) {
      report(
        `plugin '${plugin.path}' changed while loading — refusing to register it`
      );

      return undefined;
    }

    IMPORTED_AT.set(entryPath, fingerprint);

    return { mod, fingerprint };
  } catch (err) {
    report(`plugin '${plugin.path}' failed to load: ${errMessage(err)}`);

    return undefined;
  }
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
    const verified = await importVerified(plugin, entryPath, report);

    if (verified === undefined) {
      continue;
    }

    const { mod, fingerprint } = verified;

    if (!isRecord(mod)) {
      continue;
    }

    let exports: [string, unknown][];

    try {
      // Enumerating the namespace and indexing into it both run plugin code. In
      // a for-of header that runs outside every catch, so one throwing getter
      // ends the whole load — including the plugins after this one.
      exports = candidateExports(mod, plugin.packs);
    } catch (err) {
      report(
        `plugin '${plugin.path}': reading its exports failed: ${errMessage(err)}`
      );

      continue;
    }

    for (const [name, candidate] of exports) {
      let snapshot: unknown;

      try {
        // Snapshot BEFORE validating: from here on the pack is plain data, so
        // the thing that was checked and the thing that gets registered cannot
        // differ. Reading it runs the plugin's getters, which can throw — and
        // this is outside the load try/catch, so an unguarded throw here takes
        // every other configured plugin down with it.
        snapshot = snapshotPack(candidate);
      } catch (err) {
        report(
          `plugin '${plugin.path}': reading export '${name}' failed: ${errMessage(err)}`
        );

        continue;
      }

      if (isRulePack(snapshot)) {
        const pack = freezeRulePack(snapshot);

        out.push({
          pack,
          entryPath,
          fingerprint,
          source: plugin.path,
          exportName: name,
        });
        report(`plugin '${plugin.path}': loaded pack '${pack.id}'`);
      } else {
        report(
          `plugin '${plugin.path}': export '${name}' is not a valid rule pack — skipped`
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
  // Per DECLARED NAME, not per plugin path. `{ path, packs: ["strict", "extra"] }`
  // that exports only `strict` produced a pack, so a path-level check is
  // satisfied — while `extra`, a typo or a renamed export, quietly stops being
  // enforced. A path with no `packs` list is satisfied by any pack at all.
  const empty = plugins.flatMap((p) =>
    p.packs === undefined
      ? loaded.some((l) => l.source === p.path)
        ? []
        : [p.path]
      : p.packs
          .filter(
            (name) =>
              !loaded.some((l) => l.source === p.path && l.exportName === name)
          )
          .map((name) => `${p.path} (${name})`)
  );

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
