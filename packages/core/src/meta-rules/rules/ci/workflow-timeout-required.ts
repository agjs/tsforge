import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

/**
 * GitHub Actions jobs should declare a timeout-minutes so a hung step fails fast
 * instead of occupying a runner for GitHub's 6-hour default.
 * Reusable workflow calls (job uses: ...) are exempt since they set timeouts internally.
 */
const JOB_KEY_PATTERN = /^ {2}([\w-]+):\s*(?:#.*)?$/u;

interface IJobBlock {
  readonly name: string;
  readonly lines: readonly string[];
}

function collectJobBlocks(text: string): IJobBlock[] {
  const lines = text.split("\n");
  const blocks: IJobBlock[] = [];
  let inJobs = false;
  let current: { name: string; lines: string[] } | null = null;

  for (const line of lines) {
    // Start of jobs: section
    if (/^jobs:\s*(?:#.*)?$/u.test(line)) {
      inJobs = true;
      continue;
    }

    if (!inJobs) {
      continue;
    }

    // End of jobs: section (top-level key)
    if (/^\S/u.test(line)) {
      inJobs = false;

      if (current !== null) {
        blocks.push(current);
        current = null;
      }

      continue;
    }

    // Job definition line
    const jobMatch = JOB_KEY_PATTERN.exec(line);

    if (jobMatch?.[1] !== undefined) {
      if (current !== null) {
        blocks.push(current);
      }

      current = { name: jobMatch[1], lines: [] };
      continue;
    }

    if (current !== null) {
      current.lines.push(line);
    }
  }

  if (current !== null) {
    blocks.push(current);
  }

  return blocks;
}

export const workflowTimeoutRequiredRule: IMetaRule = {
  id: "workflow-timeout-required",
  category: "ci",
  description:
    "GitHub Actions jobs require an explicit timeout-minutes (reusable-workflow calls exempt).",
  severity: "warn",
  run({ workflowFiles, readFile }) {
    const violations: IMetaRuleViolation[] = [];

    for (const file of workflowFiles) {
      const text = readFile(file);

      if (text === null) {
        continue;
      }

      const jobs = collectJobBlocks(text);

      for (const job of jobs) {
        // Check if this is a reusable workflow call
        const isReusableCall = job.lines.some((line) =>
          /^ {4}uses:\s*\S/u.test(line)
        );

        if (isReusableCall) {
          continue;
        }

        // Check for timeout-minutes
        const hasTimeout = job.lines.some((line) =>
          /^ {4}timeout-minutes:\s*[1-9]\d*\s*(?:#.*)?$/u.test(line)
        );

        if (!hasTimeout) {
          violations.push({
            file,
            ruleId: "workflow-timeout-required",
            severity: "warn",
            message: `Job "${job.name}" has no job-level \`timeout-minutes:\` — a hung step runs for GitHub's 6h default and blocks the PR check.`,
          });
        }
      }
    }

    return violations;
  },
};
