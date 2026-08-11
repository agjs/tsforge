import type { TSESLint } from "@typescript-eslint/utils";

import { fakeTimersMustBeRestoredRule } from "./rules/fake-timers-must-be-restored";
import { noConditionalExpectRule } from "./rules/no-conditional-expect";
import { noFocusedTestsRule } from "./rules/no-focused-tests";
import { noRealNetworkInUnitTestsRule } from "./rules/no-real-network-in-unit-tests";
import { noVacuousExpectRule } from "./rules/no-vacuous-expect";
import { testFileMirrorsSourceRule } from "./rules/test-file-mirrors-source";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "fake-timers-must-be-restored": fakeTimersMustBeRestoredRule,
  "no-conditional-expect": noConditionalExpectRule,
  "no-focused-tests": noFocusedTestsRule,
  "no-real-network-in-unit-tests": noRealNetworkInUnitTestsRule,
  "no-vacuous-expect": noVacuousExpectRule,
  "test-file-mirrors-source": testFileMirrorsSourceRule,
};

export const testConventionsPack: IRulePack = {
  id: "test-conventions",
  description:
    "Testing patterns and file structure for vitest, jest, or Bun tests",
  rules,
  rulesConfig: {
    "fake-timers-must-be-restored": "error",
    "no-conditional-expect": "error",
    "no-focused-tests": "error",
    "no-real-network-in-unit-tests": "warn",
    "no-vacuous-expect": "error",
    "test-file-mirrors-source": "error",
  },
};

export default testConventionsPack;
