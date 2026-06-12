import type { TSESLint } from "@typescript-eslint/utils";

import { noBareDateNowRule } from "./rules/no-bare-date-now";
import { noTemplateTrimEmptyTernaryRule } from "./rules/no-template-trim-empty-ternary";
import { preferEarlyReturnRule } from "./rules/prefer-early-return";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "no-bare-date-now": noBareDateNowRule,
  "no-template-trim-empty-ternary": noTemplateTrimEmptyTernaryRule,
  "prefer-early-return": preferEarlyReturnRule,
};

export const codeFlowPack: IRulePack = {
  id: "code-flow",
  description: "Control flow clarity and early returns",
  rules,
  rulesConfig: {
    "no-bare-date-now": "error",
    "no-template-trim-empty-ternary": "error",
    "prefer-early-return": "error",
  },
};

export default codeFlowPack;
