import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";
import {
  collectWorkflowPermissionsLines,
  hasWorkflowLevelPermissions,
} from "../../utils/workflow-yaml";

const BROAD_PERMISSION_PATTERN =
  /^ {2}(?:contents|id-token):\s*write\s*(?:#.*)?$/u;

export const workflowPermissionsLeastPrivilegeRule: IMetaRule = {
  id: "workflow-permissions-least-privilege",
  category: "ci",
  description:
    "Warn when workflow-level permissions grant contents: write or id-token: write.",
  severity: "warn",
  run({ workflowFiles, readFile }) {
    const violations: IMetaRuleViolation[] = [];

    for (const file of workflowFiles) {
      const text = readFile(file);

      if (text === null || !hasWorkflowLevelPermissions(text)) {
        continue;
      }

      const permissionLines = collectWorkflowPermissionsLines(text);

      for (const line of permissionLines) {
        if (!BROAD_PERMISSION_PATTERN.test(line)) {
          continue;
        }

        violations.push({
          file,
          ruleId: "workflow-permissions-least-privilege",
          severity: "warn",
          message: `Workflow-level \`${line.trim()}\` is broader than necessary — scope write permissions to the job that needs them instead of the whole workflow.`,
        });
      }
    }

    return violations;
  },
};
