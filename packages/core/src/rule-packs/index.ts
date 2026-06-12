import type { TSESLint } from "@typescript-eslint/utils";

import { commentHygienePack } from "./comment-hygiene";
import { codeFlowPack } from "./code-flow";
import { envAccessPack } from "./env-access";
import { moduleBoundariesPack } from "./module-boundaries";
import { testConventionsPack } from "./test-conventions";

/** Registry of all available rule packs, keyed by pack ID. */
export const RULE_PACKS = {
  "env-access": envAccessPack,
  "code-flow": codeFlowPack,
  "comment-hygiene": commentHygienePack,
  "module-boundaries": moduleBoundariesPack,
  "test-conventions": testConventionsPack,
} as const;

export type IRulePackId = keyof typeof RULE_PACKS;

/**
 * Builds an ESLint plugin and merged config from a selection of rule packs.
 * Returns both the merged plugin (for registration under `tsforge` namespace)
 * and the rules config (mapping rule names to severities).
 *
 * @throws if any two packs define the same rule name
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

    if (pack === undefined) {
      throw new Error(`Unknown rule pack: ${packId}`);
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
