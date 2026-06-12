import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

/**
 * GitHub runner images should pin to an explicit OS version (e.g. ubuntu-24.04)
 * instead of floating tags (ubuntu-latest). Floating tags can change between
 * runs with no repo diff, causing non-deterministic CI behavior.
 */
const RUNS_ON_PATTERN = /^\s*runs-on:\s*(?<label>\S+)\s*(?:#.*)?$/u;

export const workflowRunnerPinnedRule: IMetaRule = {
  id: "workflow-runner-pinned",
  category: "ci",
  description:
    "Workflows must pin runner images to an explicit OS version (e.g. ubuntu-24.04) instead of floating *-latest labels.",
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
        const match = RUNS_ON_PATTERN.exec(line);
        const label = match?.groups?.label;

        if (label === undefined) {
          continue;
        }

        // Skip matrix variables (start with $)
        if (label.startsWith("$")) {
          continue;
        }

        // Check if the label ends with -latest (floating)
        const normalized = label.replace(/['"]/gu, "");

        if (normalized.endsWith("-latest")) {
          violations.push({
            file,
            ruleId: "workflow-runner-pinned",
            severity: "warn",
            message: `runs-on: ${normalized} floats with GitHub's runner image migrations — tool versions change between runs with no repo diff. Pin an explicit OS version (e.g. ubuntu-24.04).`,
          });
        }
      }
    }

    return violations;
  },
};
