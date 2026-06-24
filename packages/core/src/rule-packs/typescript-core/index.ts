import type { TSESLint } from "@typescript-eslint/utils";

import { exportedFunctionsRequireReturnTypeRule } from "./rules/exported-functions-require-return-type";
import { fetchMustCheckOkRule } from "./rules/fetch-must-check-ok";
import { jsonParseMustValidateRule } from "./rules/json-parse-must-validate";
import { noUnsafeBoundaryCastRule } from "./rules/no-unsafe-boundary-cast";
import { noSelfImportRule } from "./rules/no-self-import";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "exported-functions-require-return-type":
    exportedFunctionsRequireReturnTypeRule,
  "fetch-must-check-ok": fetchMustCheckOkRule,
  "json-parse-must-validate": jsonParseMustValidateRule,
  "no-unsafe-boundary-cast": noUnsafeBoundaryCastRule,
  "no-self-import": noSelfImportRule,
};

export const typescriptCorePack: IRulePack = {
  id: "typescript-core",
  description:
    "Cross-cutting TypeScript boundary safety: fetch status checks, JSON validation, and module export typing.",
  rules,
  rulesConfig: {
    "exported-functions-require-return-type": "warn",
    "fetch-must-check-ok": "error",
    "json-parse-must-validate": "error",
    "no-unsafe-boundary-cast": "error",
    "no-self-import": "error",
  },
};

export default typescriptCorePack;
