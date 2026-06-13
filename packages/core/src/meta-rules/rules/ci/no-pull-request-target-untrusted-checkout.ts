import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

const PULL_REQUEST_TARGET_PATTERN = /(?:^|\s)pull_request_target(?:\s|:|$)/u;
const UNTRUSTED_CHECKOUT_PATTERN =
  /github\.event\.pull_request\.head\.(?:sha|ref)/u;

export const noPullRequestTargetUntrustedCheckoutRule: IMetaRule = {
  id: "no-pull-request-target-untrusted-checkout",
  category: "ci",
  description:
    "Disallow pull_request_target workflows that checkout the PR head ref (untrusted code with write token).",
  severity: "warn",
  run({ workflowFiles, readFile }) {
    const violations: IMetaRuleViolation[] = [];

    for (const file of workflowFiles) {
      const text = readFile(file);

      if (text === null) {
        continue;
      }

      if (!PULL_REQUEST_TARGET_PATTERN.test(text)) {
        continue;
      }

      if (!UNTRUSTED_CHECKOUT_PATTERN.test(text)) {
        continue;
      }

      violations.push({
        file,
        ruleId: "no-pull-request-target-untrusted-checkout",
        severity: "warn",
        message:
          "`pull_request_target` combined with checkout of `github.event.pull_request.head.*` runs untrusted PR code with elevated workflow permissions — use `pull_request` or checkout the base ref instead.",
      });
    }

    return violations;
  },
};
