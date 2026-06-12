import type { TSESLint } from "@typescript-eslint/utils";

import { jobNameMustBeConstantRule } from "./rules/job-name-must-be-constant";
import { jobOptionsMustSetAttemptsRule } from "./rules/job-options-must-set-attempts";
import { noBlockingConcurrencyZeroRule } from "./rules/no-blocking-concurrency-zero";
import { queueOptionsMustSetRemoveOnCompleteRule } from "./rules/queue-options-must-set-removeoncomplete";
import { queueOptionsMustSetRemoveOnFailRule } from "./rules/queue-options-must-set-removeonfail";
import { workerMustImplementCloseRule } from "./rules/worker-must-implement-close";
import { workerMustListenFailedRule } from "./rules/worker-must-listen-failed";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "job-name-must-be-constant": jobNameMustBeConstantRule,
  "job-options-must-set-attempts": jobOptionsMustSetAttemptsRule,
  "no-blocking-concurrency-zero": noBlockingConcurrencyZeroRule,
  "queue-options-must-set-removeoncomplete":
    queueOptionsMustSetRemoveOnCompleteRule,
  "queue-options-must-set-removeonfail": queueOptionsMustSetRemoveOnFailRule,
  "worker-must-implement-close": workerMustImplementCloseRule,
  "worker-must-listen-failed": workerMustListenFailedRule,
};

export const bullmqPack: IRulePack = {
  id: "bullmq",
  description:
    "Job queue patterns with BullMQ (queue options, worker lifecycle, job naming)",
  rules,
  rulesConfig: {
    "job-name-must-be-constant": "warn",
    "job-options-must-set-attempts": "error",
    "no-blocking-concurrency-zero": "error",
    "queue-options-must-set-removeoncomplete": "error",
    "queue-options-must-set-removeonfail": "error",
    "worker-must-implement-close": "error",
    "worker-must-listen-failed": "error",
  },
};

export default bullmqPack;
