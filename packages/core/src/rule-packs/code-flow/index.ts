import type { TSESLint } from "@typescript-eslint/utils";

import { noBareDateNowRule } from "./rules/no-bare-date-now";
import { noTemplateTrimEmptyTernaryRule } from "./rules/no-template-trim-empty-ternary";
import { noThrowLiteralRule } from "./rules/no-throw-literal";
import { preferEarlyReturnRule } from "./rules/prefer-early-return";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "no-bare-date-now": noBareDateNowRule,
  "no-template-trim-empty-ternary": noTemplateTrimEmptyTernaryRule,
  "no-throw-literal": noThrowLiteralRule,
  "prefer-early-return": preferEarlyReturnRule,
};

export const codeFlowPack: IRulePack = {
  id: "code-flow",
  description: "Control flow clarity and early returns",
  rules,
  rulesConfig: {
    "no-bare-date-now": "error",
    "no-template-trim-empty-ternary": "error",
    "no-throw-literal": "error",
    "prefer-early-return": "warn",
  },
};

export default codeFlowPack;
