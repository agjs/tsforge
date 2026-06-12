import type { TSESLint } from "@typescript-eslint/utils";

import { maskPiiFieldsRule } from "./rules/mask-pii-fields";
import { noErrorStringifyRule } from "./rules/no-error-stringify";
import { requireEventFieldRule } from "./rules/require-event-field";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "mask-pii-fields": maskPiiFieldsRule,
  "no-error-stringify": noErrorStringifyRule,
  "require-event-field": requireEventFieldRule,
};

export const structuredLoggingPack: IRulePack = {
  id: "structured-logging",
  description:
    "Structured logging best practices: PII masking, error handling, and event field requirements",
  rules,
  rulesConfig: {
    "mask-pii-fields": "error",
    "no-error-stringify": "error",
    "require-event-field": "error",
  },
};

export default structuredLoggingPack;
