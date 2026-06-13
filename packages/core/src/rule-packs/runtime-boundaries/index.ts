import type { TSESLint } from "@typescript-eslint/utils";

import { noPrototypePollutingMergeRule } from "./rules/no-prototype-polluting-merge";
import { noUserControlledFetchUrlRule } from "./rules/no-user-controlled-fetch-url";
import { noUserControlledRedirectRule } from "./rules/no-user-controlled-redirect";
import { uploadMustSetLimitsRule } from "./rules/upload-must-set-limits";
import { webhookMustVerifySignatureBeforeParseRule } from "./rules/webhook-must-verify-signature-before-parse";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "no-prototype-polluting-merge": noPrototypePollutingMergeRule,
  "no-user-controlled-fetch-url": noUserControlledFetchUrlRule,
  "no-user-controlled-redirect": noUserControlledRedirectRule,
  "upload-must-set-limits": uploadMustSetLimitsRule,
  "webhook-must-verify-signature-before-parse":
    webhookMustVerifySignatureBeforeParseRule,
};

export const runtimeBoundariesPack: IRulePack = {
  id: "runtime-boundaries",
  description:
    "Runtime boundary safety: open redirects, SSRF, prototype pollution, webhook verification, and upload limits.",
  rules,
  rulesConfig: {
    "no-prototype-polluting-merge": "error",
    "no-user-controlled-fetch-url": "error",
    "no-user-controlled-redirect": "error",
    "upload-must-set-limits": "warn",
    "webhook-must-verify-signature-before-parse": "warn",
  },
};

export default runtimeBoundariesPack;
