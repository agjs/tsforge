import type { TSESLint } from "@typescript-eslint/utils";

import { pkceRequiredForOidcRule } from "./rules/pkce-required-for-oidc";
import { stateMustBeRedisBackedRule } from "./rules/state-must-be-redis-backed";
import { stateTtlBoundedRule } from "./rules/state-ttl-bounded";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "pkce-required-for-oidc": pkceRequiredForOidcRule,
  "state-must-be-redis-backed": stateMustBeRedisBackedRule,
  "state-ttl-bounded": stateTtlBoundedRule,
};

export const oauthSecurityPack: IRulePack = {
  id: "oauth-security",
  description: "OAuth and OpenID patterns and security considerations",
  rules,
  rulesConfig: {
    "pkce-required-for-oidc": "error",
    "state-must-be-redis-backed": "error",
    "state-ttl-bounded": "error",
  },
};

export default oauthSecurityPack;
