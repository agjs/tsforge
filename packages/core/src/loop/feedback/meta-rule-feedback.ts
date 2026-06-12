import type { IMetaRuleViolation } from "../../meta-rules";
import { META_RULE_DOCS } from "./meta-rule-docs";

/** Cap rendered meta-rule violations so error sets can't wall the model. */
const META_RULE_FEEDBACK_MAX = 10;

/**
 * Render meta-rule violations as `<file>: <message> (<ruleId>)` with severity tag.
 * Each violation gets its doc's "how" line appended if available.
 */
export function renderMetaViolations(
  violations: readonly IMetaRuleViolation[]
): string {
  const shown = violations.slice(0, META_RULE_FEEDBACK_MAX);
  const rendered: string[] = [];

  for (const v of shown) {
    const severity = v.severity === "error" ? "[ERROR]" : "[WARN]";
    const head = `- ${v.file}: ${v.message} (${v.ruleId}) ${severity}`;

    const doc = META_RULE_DOCS[v.ruleId];
    const docLine = doc !== undefined ? `\n      💡 ${doc}` : "";

    rendered.push(`${head}${docLine}`);
  }

  const more =
    violations.length > META_RULE_FEEDBACK_MAX
      ? `\n… and ${String(violations.length - META_RULE_FEEDBACK_MAX)} more project structure violations.`
      : "";

  return rendered.join("\n") + more;
}

/**
 * Extract unique meta-rule docs from violations for a help block.
 * Format: `ruleId: <doc>\n`
 */
export function metaRuleHelp(
  violations: readonly IMetaRuleViolation[]
): string {
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const v of violations) {
    if (seen.has(v.ruleId)) {
      continue;
    }

    const doc = META_RULE_DOCS[v.ruleId];

    if (doc === undefined) {
      continue;
    }

    seen.add(v.ruleId);
    blocks.push(`${v.ruleId}: ${doc}`);
  }

  return blocks.length > 0 ? blocks.map((b) => `  ${b}`).join("\n") : "";
}
