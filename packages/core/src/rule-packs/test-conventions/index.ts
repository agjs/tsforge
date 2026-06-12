import type { TSESLint } from "@typescript-eslint/utils";

import { noFocusedTestsRule } from "./rules/no-focused-tests";
import { testFileMirrorsSourceRule } from "./rules/test-file-mirrors-source";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "no-focused-tests": noFocusedTestsRule,
  "test-file-mirrors-source": testFileMirrorsSourceRule,
};

export const testConventionsPack: IRulePack = {
  id: "test-conventions",
  description:
    "Testing patterns and file structure for vitest, jest, or Bun tests",
  rules,
  rulesConfig: {
    "no-focused-tests": "error",
    "test-file-mirrors-source": "error",
  },
};

export default testConventionsPack;
