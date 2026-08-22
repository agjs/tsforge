import type { TSESLint } from "@typescript-eslint/utils";

import type { IRulePack } from "./rule-packs.types";
import { ExternalPackDriftError } from "./drift-error";
import { aiSdkPack } from "./ai-sdk";
import { authorizationPack } from "./authorization";
import { bullmqPack } from "./bullmq";
import { commentHygienePack } from "./comment-hygiene";
import { codeFlowPack } from "./code-flow";
import { drizzlePack } from "./drizzle";
import { elysiaPack } from "./elysia";
import { envAccessPack } from "./env-access";
import { fastifyPack } from "./fastify";
import { i18nKeysPack } from "./i18n-keys";
import { jwtCookiesPack } from "./jwt-cookies";
import { moduleBoundariesPack } from "./module-boundaries";
import { nextjsPack } from "./nextjs";
import { oauthSecurityPack } from "./oauth-security";
import { reactComponentArchitecturePack } from "./react-component-architecture";
import { runtimeBoundariesPack } from "./runtime-boundaries";
import { securityPack } from "./security";
import { structuredLoggingPack } from "./structured-logging";
import { tanstackQueryPack } from "./tanstack-query";
import { testConventionsPack } from "./test-conventions";
import { threePack } from "./three";
import { typescriptCorePack } from "./typescript-core";
import { PACK_REGISTRY } from "../stack-detection";

/** Registry of all available rule packs, keyed by pack ID. */
export const RULE_PACKS = {
  "ai-sdk": aiSdkPack,
  authorization: authorizationPack,
  bullmq: bullmqPack,
  "code-flow": codeFlowPack,
  "comment-hygiene": commentHygienePack,
  drizzle: drizzlePack,
  elysia: elysiaPack,
  fastify: fastifyPack,
  "env-access": envAccessPack,
  "i18n-keys": i18nKeysPack,
  "jwt-cookies": jwtCookiesPack,
  "module-boundaries": moduleBoundariesPack,
  nextjs: nextjsPack,
  "oauth-security": oauthSecurityPack,
  "react-component-architecture": reactComponentArchitecturePack,
  "runtime-boundaries": runtimeBoundariesPack,
  security: securityPack,
  "structured-logging": structuredLoggingPack,
  "tanstack-query": tanstackQueryPack,
  "test-conventions": testConventionsPack,
  three: threePack,
  "typescript-core": typescriptCorePack,
} as const;

export type IRulePackId = keyof typeof RULE_PACKS;

/** Type guard: check if a string is a valid RULE_PACKS key. */
function isRulePackId(id: unknown): id is IRulePackId {
  // `Object.hasOwn`, NOT the `in` operator — `in` walks the prototype chain, so
  // "constructor"/"toString"/"__proto__" would falsely validate as pack ids and
  // resolve to an Object.prototype member instead of a pack.
  return typeof id === "string" && Object.hasOwn(RULE_PACKS, id);
}

/** Metadata required to freeze an external pack against mid-session edits. */
export interface IExternalPackFreeze {
  /** Absolute path of the plugin entry module that was loaded. */
  readonly entryPath: string;
  /** SHA-256 hex of the entry + relative import graph at load time. */
  readonly fingerprint: string;
}

/** Externally-registered rule packs (from tsforge.config.json `plugins`). Kept
 *  separate from the built-in RULE_PACKS so a user pack can never shadow a
 *  built-in by id; rule-name collisions still fail the build in
 *  buildPackEslintConfig.
 *
 *  The pack and the fingerprint that pins it live in ONE entry on purpose: as
 *  two maps with an optional freeze, a caller could register a resolvable pack
 *  with nothing guarding it, and the drift check would skip it while its rules
 *  were still applied. Here an unpinned external pack cannot be expressed. */
const EXTERNAL_PACKS = new Map<
  string,
  { readonly pack: IRulePack; readonly freeze: IExternalPackFreeze }
>();

/** Register an external rule pack so its id resolves in buildPackEslintConfig.
 *  `freeze` pins the on-disk content that produced this pack — it is required,
 *  because a pack that resolves but cannot be re-verified is the hole the freeze
 *  exists to close. */
export function registerExternalPack(
  pack: IRulePack,
  freeze: IExternalPackFreeze
): void {
  const existing = EXTERNAL_PACKS.get(pack.id);

  if (existing !== undefined) {
    // Idempotent when the same entry is loaded again (workspace children that
    // inherit one root plugin). Different paths/content must not overwrite.
    if (
      existing.freeze.entryPath === freeze.entryPath &&
      existing.freeze.fingerprint === freeze.fingerprint
    ) {
      return;
    }

    throw new Error(
      `tsforge: external pack id '${pack.id}' already registered from ${existing.freeze.entryPath}; ` +
        `refusing to overwrite with ${freeze.entryPath}`
    );
  }

  EXTERNAL_PACKS.set(pack.id, { pack, freeze });
}

/** Drop all registered external packs (used by tests for isolation). */
export function clearExternalPacks(): void {
  EXTERNAL_PACKS.clear();
}

/**
 * Re-hash every registered external plugin entry and throw if any on-disk
 * content no longer matches the fingerprint captured at load. A workspace
 * plugin edited mid-session must hard-fail rather than silently weaken rules
 * under the same pack id.
 */
export async function assertExternalPacksFrozen(): Promise<void> {
  if (EXTERNAL_PACKS.size === 0) {
    return;
  }

  const { fingerprintPluginEntry } =
    await import("../config/plugin-fingerprint");

  for (const [id, { freeze: meta }] of EXTERNAL_PACKS) {
    // A re-hash that CANNOT be computed (entry deleted, unreadable, grown past
    // the freeze limit) is drift: the one thing it is not is proof of no change.
    // It also has to surface as the drift type, or the write path's best-effort
    // catch would swallow it.
    const now = await fingerprintPluginEntry(meta.entryPath).catch(
      (err: unknown) => {
        throw new ExternalPackDriftError(
          `tsforge: external plugin pack '${id}' can no longer be verified (${meta.entryPath}): ${err instanceof Error ? err.message : String(err)}`,
          // Keep the original: the message says verification failed, the cause
          // says whether the entry vanished, grew past the limit, or something
          // else — and only one of those is the user's to fix.
          { cause: err }
        );
      }
    );

    if (now !== meta.fingerprint) {
      throw new ExternalPackDriftError(
        `tsforge: external plugin pack '${id}' changed on disk since load (${meta.entryPath}). ` +
          `Refusing to run with drifted plugin content — restart the session after intentional plugin edits.`
      );
    }
  }
}

/** Resolve a pack id to its definition, built-ins first, then external packs. */
function lookupPack(packId: string): IRulePack | undefined {
  if (isRulePackId(packId)) {
    return RULE_PACKS[packId];
  }

  return EXTERNAL_PACKS.get(packId)?.pack;
}

/** Apply rule overrides: "off" drops a rule, error/warn replaces its severity. */
function applyOverrides(
  mergedRulesConfig: Readonly<Record<string, "error" | "warn">>,
  overrides?: Readonly<Record<string, "error" | "warn" | "off">>
): Record<string, "error" | "warn"> {
  const result: Record<string, "error" | "warn"> = {};

  for (const [key, severity] of Object.entries(mergedRulesConfig)) {
    const bareName = key.startsWith("tsforge/") ? key.slice(8) : key;
    const override = overrides?.[bareName];

    if (override === "off") {
      continue;
    }

    result[key] = override ?? severity;
  }

  return result;
}

/**
 * Builds an ESLint plugin and merged config from a selection of rule packs.
 * Pack IDs present in stack-detection's PACK_REGISTRY but absent from RULE_PACKS
 * are silently skipped (they may carry meta-rules later, not eslint rules).
 * Throws only for IDs unknown to both registries.
 *
 * @param packIds Pack IDs to build config from
 * @param overrides Optional rule severity overrides (keyed by bare rule name, not tsforge-prefixed)
 *   - "off" removes the rule from the config
 *   - "error"/"warn" replaces the severity
 *
 * @throws if any two packs define the same rule name
 * @throws if a pack ID is unknown to both RULE_PACKS and PACK_REGISTRY
 */
export function buildPackEslintConfig(
  packIds: readonly string[],
  overrides?: Readonly<Record<string, "error" | "warn" | "off">>
): {
  plugin: TSESLint.FlatConfig.Plugin;
  rules: Record<string, "error" | "warn">;
} {
  const mergedRules: Record<
    string,
    TSESLint.RuleModule<string, readonly unknown[]>
  > = {};
  const mergedRulesConfig: Record<string, "error" | "warn"> = {};
  const seenRuleNames = new Set<string>();

  for (const packId of packIds) {
    const pack = lookupPack(packId);

    // Skip pack IDs known to stack-detection but absent from RULE_PACKS
    if (pack === undefined) {
      const knownInRegistry = Object.hasOwn(PACK_REGISTRY, packId);

      if (!knownInRegistry) {
        throw new Error(`Unknown rule pack: ${packId}`);
      }

      // Pack is in registry but not in RULE_PACKS — skip silently
      continue;
    }

    for (const [ruleName, ruleModule] of Object.entries(pack.rules)) {
      if (seenRuleNames.has(ruleName)) {
        throw new Error(
          `Rule collision: '${ruleName}' defined in multiple packs`
        );
      }

      seenRuleNames.add(ruleName);
      mergedRules[ruleName] = ruleModule;
      const severity = pack.rulesConfig[ruleName];

      if (severity !== undefined) {
        mergedRulesConfig[`tsforge/${ruleName}`] = severity;
      }
    }
  }

  const finalRulesConfig = applyOverrides(mergedRulesConfig, overrides);

  const plugin: TSESLint.FlatConfig.Plugin = {
    meta: {
      name: "tsforge",
      version: "0.1.0",
    },
    rules: mergedRules,
  };

  return {
    plugin,
    rules: finalRulesConfig,
  };
}

export type { IRulePack } from "./rule-packs.types";
