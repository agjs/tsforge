import type {
  IMetaRule,
  IMetaRuleContext,
  IMetaRuleViolation,
} from "./meta-rules.types";

/**
 * Run applicable meta-rules and return violations sorted deterministically
 * (by file, then rule ID).
 */
export function runMetaRules(
  rules: readonly IMetaRule[],
  ctx: IMetaRuleContext
): IMetaRuleViolation[] {
  const violations: IMetaRuleViolation[] = [];

  for (const rule of rules) {
    // Check if rule applies to this project's active packs
    if (rule.appliesTo !== undefined && rule.appliesTo.length > 0) {
      const applies = rule.appliesTo.some((pack) =>
        ctx.activePacks.includes(pack)
      );

      if (!applies) {
        continue;
      }
    }

    violations.push(...rule.run(ctx));
  }

  // Deterministic ordering: file path, then rule ID
  violations.sort((a, b) => {
    const fileCmp = a.file.localeCompare(b.file);

    if (fileCmp !== 0) {
      return fileCmp;
    }

    return a.ruleId.localeCompare(b.ruleId);
  });

  return violations;
}
