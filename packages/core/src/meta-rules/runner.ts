import type {
  IMetaRule,
  IMetaRuleContext,
  IMetaRuleViolation,
} from "./meta-rules.types";

/**
 * Run applicable meta-rules and return violations sorted deterministically
 * (by file, then rule ID). Severity overrides can silence rules ("off") or
 * change their severity (rule ID mapped to "error" | "warn" | "off").
 */
export function runMetaRules(
  rules: readonly IMetaRule[],
  ctx: IMetaRuleContext,
  severityOverrides?: Readonly<Record<string, "error" | "warn" | "off">>
): IMetaRuleViolation[] {
  const violations: IMetaRuleViolation[] = [];

  for (const rule of rules) {
    // Check if rule is silenced via overrides
    if (severityOverrides?.[rule.id] === "off") {
      continue;
    }

    // Check if rule applies to this project's active packs
    if (rule.appliesTo !== undefined && rule.appliesTo.length > 0) {
      const applies = rule.appliesTo.some((pack) =>
        ctx.activePacks.includes(pack)
      );

      if (!applies) {
        continue;
      }
    }

    const ruleViolations = rule.run(ctx);
    const override = severityOverrides?.[rule.id];

    // Apply severity override if present (and not "off")
    if (override !== undefined && override !== "off") {
      for (const v of ruleViolations) {
        violations.push({
          ...v,
          severity: override,
        });
      }
    } else {
      violations.push(...ruleViolations);
    }
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
