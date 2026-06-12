import type { TSESLint } from "@typescript-eslint/utils";

import { bullmqPack } from "./bullmq";
import { commentHygienePack } from "./comment-hygiene";
import { codeFlowPack } from "./code-flow";
import { drizzlePack } from "./drizzle";
import { elysiaPack } from "./elysia";
import { envAccessPack } from "./env-access";
import { i18nKeysPack } from "./i18n-keys";
import { jwtCookiesPack } from "./jwt-cookies";
import { oauthSecurityPack } from "./oauth-security";
import { reactComponentArchitecturePack } from "./react-component-architecture";
import { structuredLoggingPack } from "./structured-logging";
import { tanstackQueryPack } from "./tanstack-query";
import { testConventionsPack } from "./test-conventions";
import { PACK_REGISTRY } from "../stack-detection";

/** Registry of all available rule packs, keyed by pack ID. */
export const RULE_PACKS = {
  bullmq: bullmqPack,
  "code-flow": codeFlowPack,
  "comment-hygiene": commentHygienePack,
  drizzle: drizzlePack,
  elysia: elysiaPack,
  "env-access": envAccessPack,
  "i18n-keys": i18nKeysPack,
  "jwt-cookies": jwtCookiesPack,
  "oauth-security": oauthSecurityPack,
  "react-component-architecture": reactComponentArchitecturePack,
  "structured-logging": structuredLoggingPack,
  "tanstack-query": tanstackQueryPack,
  "test-conventions": testConventionsPack,
} as const;

export type IRulePackId = keyof typeof RULE_PACKS;

/** Type guard: check if a string is a valid RULE_PACKS key. */
function isRulePackId(id: unknown): id is IRulePackId {
  return typeof id === "string" && id in RULE_PACKS;
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
    const pack = isRulePackId(packId) ? RULE_PACKS[packId] : undefined;

    // Skip pack IDs known to stack-detection but absent from RULE_PACKS
    if (pack === undefined) {
      const knownInRegistry = packId in PACK_REGISTRY;

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
