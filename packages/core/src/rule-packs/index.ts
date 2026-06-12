import type { TSESLint } from "@typescript-eslint/utils";

import { bullmqPack } from "./bullmq";
import { commentHygienePack } from "./comment-hygiene";
import { codeFlowPack } from "./code-flow";
import { drizzlePack } from "./drizzle";
import { elysiaPack } from "./elysia";
import { envAccessPack } from "./env-access";
import { structuredLoggingPack } from "./structured-logging";
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
  "structured-logging": structuredLoggingPack,
  "test-conventions": testConventionsPack,
} as const;

export type IRulePackId = keyof typeof RULE_PACKS;

/**
 * Builds an ESLint plugin and merged config from a selection of rule packs.
 * Pack IDs present in stack-detection's PACK_REGISTRY but absent from RULE_PACKS
 * are silently skipped (they may carry meta-rules later, not eslint rules).
 * Throws only for IDs unknown to both registries.
 *
 * @throws if any two packs define the same rule name
 * @throws if a pack ID is unknown to both RULE_PACKS and PACK_REGISTRY
 */
export function buildPackEslintConfig(packIds: readonly IRulePackId[]): {
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
    const pack = RULE_PACKS[packId];

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

  const plugin: TSESLint.FlatConfig.Plugin = {
    meta: {
      name: "tsforge",
      version: "0.1.0",
    },
    rules: mergedRules,
  };

  return {
    plugin,
    rules: mergedRulesConfig,
  };
}

export type { IRulePack } from "./rule-packs.types";
