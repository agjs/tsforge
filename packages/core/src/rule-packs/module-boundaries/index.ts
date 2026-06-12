import type { TSESLint } from "@typescript-eslint/utils";

import { singleSemanticModuleRule } from "./rules/single-semantic-module";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "single-semantic-module": singleSemanticModuleRule,
};

export const moduleBoundariesPack: IRulePack = {
  id: "module-boundaries",
  description: "Enforce clear module boundaries and layering",
  rules,
  rulesConfig: {
    "single-semantic-module": "error",
  },
};

export default moduleBoundariesPack;
