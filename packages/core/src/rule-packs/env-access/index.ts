import type { TSESLint } from "@typescript-eslint/utils";

import { noDirectProcessEnvRule } from "./rules/no-direct-process-env";
import { noProcessExitRule } from "./rules/no-process-exit";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "no-direct-process-env": noDirectProcessEnvRule,
  "no-process-exit": noProcessExitRule,
};

export const envAccessPack: IRulePack = {
  id: "env-access",
  description:
    "Safe environment variable access patterns (validation and typing)",
  rules,
  rulesConfig: {
    "no-direct-process-env": "error",
    "no-process-exit": "error",
  },
};

export default envAccessPack;
