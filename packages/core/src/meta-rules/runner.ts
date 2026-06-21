import type {
  IMetaRule,
  IMetaRuleContext,
  IMetaRuleViolation,
} from "./meta-rules.types";

type SeverityOverride = "error" | "warn" | "off";

/** Whether the rule should run at all for this context (not silenced "off", and
 *  — if pack-scoped — at least one of its packs is active). */
function ruleEnabled(
  rule: IMetaRule,
  ctx: IMetaRuleContext,
  override: SeverityOverride | undefined
): boolean {
  if (override === "off") {
    return false;
  }

  if (rule.appliesTo === undefined || rule.appliesTo.length === 0) {
    return true;
  }

  return rule.appliesTo.some((pack) => ctx.activePacks.includes(pack));
}

/** Run ONE rule, isolated. A throwing rule (a harness bug — an unexpected AST
 *  shape, a bad regex) must NOT abort the whole batch: without isolation one
 *  broken rule makes runMetaRules throw, the gate's call-site catch swallows it
 *  to an EMPTY list, and EVERY other meta-rule is silently skipped for the cycle
 *  — a real violation (test-sibling, supply-chain, circular-imports) goes
 *  unreported and the gate can go GREEN. The failure surfaces as a non-blocking
 *  warning (a harness bug shouldn't hard-fail the user's gate). A present
 *  override (not "off") rewrites each violation's severity. */
function runOneRule(
  rule: IMetaRule,
  ctx: IMetaRuleContext,
  override: SeverityOverride | undefined
): IMetaRuleViolation[] {
  let ruleViolations: IMetaRuleViolation[];

  try {
    ruleViolations = rule.run(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return [
      {
        file: `(meta-rule ${rule.id})`,
        ruleId: rule.id,
        severity: "warn",
        message: `meta-rule "${rule.id}" failed to run and was skipped: ${message}`,
      },
    ];
  }

  if (override !== undefined && override !== "off") {
    return ruleViolations.map((v) => ({ ...v, severity: override }));
  }

  return ruleViolations;
}

/**
 * Run applicable meta-rules and return violations sorted deterministically
 * (by file, then rule ID). Severity overrides can silence rules ("off") or
 * change their severity (rule ID mapped to "error" | "warn" | "off"). Each rule
 * runs in isolation — a throwing rule can't disable the others (see runOneRule).
 */
export function runMetaRules(
  rules: readonly IMetaRule[],
  ctx: IMetaRuleContext,
  severityOverrides?: Readonly<Record<string, SeverityOverride>>
): IMetaRuleViolation[] {
  const violations: IMetaRuleViolation[] = [];

  for (const rule of rules) {
    const override = severityOverrides?.[rule.id];

    if (!ruleEnabled(rule, ctx, override)) {
      continue;
    }

    violations.push(...runOneRule(rule, ctx, override));
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
