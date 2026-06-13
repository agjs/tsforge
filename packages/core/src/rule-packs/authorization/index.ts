import type { TSESLint } from "@typescript-eslint/utils";

import { idParamRequiresObjectAuthzRule } from "./rules/id-param-requires-object-authz";
import { mutatingRouteRequiresAuthzRule } from "./rules/mutating-route-requires-authz";
import { serverActionRequiresAuthzRule } from "./rules/server-action-requires-authz";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "id-param-requires-object-authz": idParamRequiresObjectAuthzRule,
  "mutating-route-requires-authz": mutatingRouteRequiresAuthzRule,
  "server-action-requires-authz": serverActionRequiresAuthzRule,
};

export const authorizationPack: IRulePack = {
  id: "authorization",
  description:
    "Experimental authorization heuristics for route handlers, server actions, and id-scoped database access.",
  rules,
  rulesConfig: {
    "mutating-route-requires-authz": "error",
    "server-action-requires-authz": "error",
    "id-param-requires-object-authz": "warn",
  },
};

export default authorizationPack;
