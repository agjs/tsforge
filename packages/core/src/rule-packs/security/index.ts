import type { TSESLint } from "@typescript-eslint/utils";

import { catchMustHandleRule } from "./rules/catch-must-handle";
import { noAuthTokenInStorageRule } from "./rules/no-auth-token-in-storage";
import { noChildProcessExecRule } from "./rules/no-child-process-exec";
import { noDynamicRegexpRule } from "./rules/no-dynamic-regexp";
import { noInnerHtmlAssignmentRule } from "./rules/no-inner-html-assignment";
import { noSpawnWithShellRule } from "./rules/no-spawn-with-shell";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "catch-must-handle": catchMustHandleRule,
  "no-auth-token-in-storage": noAuthTokenInStorageRule,
  "no-child-process-exec": noChildProcessExecRule,
  "no-dynamic-regexp": noDynamicRegexpRule,
  "no-inner-html-assignment": noInnerHtmlAssignmentRule,
  "no-spawn-with-shell": noSpawnWithShellRule,
};

export const securityPack: IRulePack = {
  id: "security",
  description:
    "Application security guardrails: command injection, ReDoS, DOM XSS, and silent error masking",
  rules,
  rulesConfig: {
    "catch-must-handle": "error",
    "no-auth-token-in-storage": "error",
    "no-child-process-exec": "error",
    "no-dynamic-regexp": "error",
    "no-inner-html-assignment": "error",
    "no-spawn-with-shell": "error",
  },
};

export default securityPack;
