import type { TSESLint } from "@typescript-eslint/utils";

import { prefixQueryKeyMustUseSetQueriesDataRule } from "./rules/prefix-query-key-must-use-set-queries-data";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "prefix-query-key-must-use-set-queries-data":
    prefixQueryKeyMustUseSetQueriesDataRule,
};

export const tanstackQueryPack: IRulePack = {
  id: "tanstack-query",
  description: "Patterns for data fetching with TanStack Query",
  rules,
  rulesConfig: {
    "prefix-query-key-must-use-set-queries-data": "error",
  },
};

export default tanstackQueryPack;
