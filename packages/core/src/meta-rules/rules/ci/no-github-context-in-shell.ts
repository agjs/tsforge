import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

const RUN_WITH_GITHUB_EVENT = /^ {4,}-?\s*run:\s.*\$\{\{\s*github\.event/u;

export const noGithubContextInShellRule: IMetaRule = {
  id: "no-github-context-in-shell",
  category: "ci",
  description:
    "Do not interpolate github.event context directly in run: shell steps — pass values through env: first.",
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
        if (!RUN_WITH_GITHUB_EVENT.test(line)) {
          continue;
        }

        violations.push({
          file,
          ruleId: "no-github-context-in-shell",
          severity: "warn",
          message:
            "Shell `run:` step interpolates `${{ github.event... }}` directly — assign the value to an `env:` entry and reference the env var in the script to avoid injection.",
        });
      }
    }

    return violations;
  },
};
