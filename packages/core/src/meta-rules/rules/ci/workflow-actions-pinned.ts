import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

/**
 * GitHub Actions `uses:` directive must pin to either:
 * - A full SHA (e.g. uses: actions/checkout@a1b2c3d...)
 * - A version tag (e.g. uses: actions/checkout@v3)
 *
 * Floating refs (e.g. uses: actions/checkout@main) are not allowed.
 */
const USES_PATTERN = /uses:\s*(.+?)(?:\s*#.*)?$/u;
const VALID_PIN_PATTERN = /^[\w./-]+@(?:[a-f0-9]{40}|v?\d+(?:\.\d+)*)$/u;

export const workflowActionsPinnedRule: IMetaRule = {
  id: "workflow-actions-pinned",
  category: "ci",
  description:
    "GitHub Actions `uses:` directives must pin to a version tag (v1, v2, etc.) or full SHA, not floating refs like @main.",
  severity: "warn",
  run({ workflowFiles, readFile }) {
    const violations: IMetaRuleViolation[] = [];

    for (const file of workflowFiles) {
      const text = readFile(file);

      if (text === null) {
        continue;
      }

      const lines = text.split("\n");

      for (const line of lines) {
        const match = USES_PATTERN.exec(line);

        if (match?.[1] === undefined) {
          continue;
        }

        const usesValue = match[1].trim().replace(/['"]/gu, "");

        // Skip composite actions and local actions (./...)
        if (usesValue.startsWith("./")) {
          continue;
        }

        // Check if pinned to version or SHA
        if (!VALID_PIN_PATTERN.test(usesValue)) {
          violations.push({
            file,
            ruleId: "workflow-actions-pinned",
            severity: "warn",
            message: `Action \`${usesValue}\` is not pinned to a version tag or SHA — pin to a stable release (e.g. @v3) or full commit SHA.`,
          });
        }
      }
    }

    return violations;
  },
};
