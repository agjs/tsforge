import type { TSESLint } from "@typescript-eslint/utils";

import { noApiKeyInClientRule } from "./rules/no-api-key-in-client";
import { requireCompletionTokenLimitRule } from "./rules/require-completion-token-limit";
import { noUserInputInSystemPromptRule } from "./rules/no-user-input-in-system-prompt";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "no-api-key-in-client": noApiKeyInClientRule,
  "require-completion-token-limit": requireCompletionTokenLimitRule,
  "no-user-input-in-system-prompt": noUserInputInSystemPromptRule,
};

export const aiSdkPack: IRulePack = {
  id: "ai-sdk",
  description:
    "LLM/AI-SDK security and cost guardrails: no provider key in client bundles, bounded completion tokens, and no request data spliced into the system prompt",
  rules,
  // Structural checks block (error); the injection heuristic warns until proven
  // precise — a false positive on an un-bypassable gate would deadlock the model.
  rulesConfig: {
    "no-api-key-in-client": "error",
    "require-completion-token-limit": "error",
    "no-user-input-in-system-prompt": "warn",
  },
};

export default aiSdkPack;
