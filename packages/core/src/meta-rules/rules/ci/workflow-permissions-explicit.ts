import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";
import {
  collectJobBlocks,
  hasWorkflowLevelPermissions,
} from "../../utils/workflow-yaml";

export const workflowPermissionsExplicitRule: IMetaRule = {
  id: "workflow-permissions-explicit",
  category: "ci",
  description:
    "GitHub Actions workflows must declare permissions at the workflow or job level.",
  severity: "warn",
  run({ workflowFiles, readFile }) {
    const violations: IMetaRuleViolation[] = [];

    for (const file of workflowFiles) {
      const text = readFile(file);

      if (text === null) {
        continue;
      }

      if (hasWorkflowLevelPermissions(text)) {
        continue;
      }

      const jobs = collectJobBlocks(text);
      const jobsMissingPermissions = jobs.filter(
        (job) =>
          !job.lines.some((line) => /^ {4}permissions:\s*(?:#.*)?$/u.test(line))
      );

      if (jobsMissingPermissions.length === 0) {
        continue;
      }

      const jobNames = jobsMissingPermissions.map((job) => job.name).join(", ");

      violations.push({
        file,
        ruleId: "workflow-permissions-explicit",
        severity: "warn",
        message: `Workflow is missing top-level \`permissions:\` and jobs without job-level permissions: ${jobNames}. Declare least-privilege permissions at workflow or job scope.`,
      });
    }

    return violations;
  },
};
