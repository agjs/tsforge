import type { TSESLint } from "@typescript-eslint/utils";

import { authCookieMustBeHttpOnlyRule } from "./rules/auth-cookie-must-be-httponly";
import { authCookieMustBeSecureInProdRule } from "./rules/auth-cookie-must-be-secure-in-prod";
import { authCookieMustSetMaxAgeOrExpiresRule } from "./rules/auth-cookie-must-set-maxage-or-expires";
import { authCookieMustSetSameSiteRule } from "./rules/auth-cookie-must-set-samesite";
import { bcryptRoundsMinRule } from "./rules/bcrypt-rounds-min";
import { jwtMustVerifyNotDecodeRule } from "./rules/jwt-must-verify-not-decode";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "auth-cookie-must-be-httponly": authCookieMustBeHttpOnlyRule,
  "auth-cookie-must-be-secure-in-prod": authCookieMustBeSecureInProdRule,
  "auth-cookie-must-set-maxage-or-expires":
    authCookieMustSetMaxAgeOrExpiresRule,
  "auth-cookie-must-set-samesite": authCookieMustSetSameSiteRule,
  "bcrypt-rounds-min": bcryptRoundsMinRule,
  "jwt-must-verify-not-decode": jwtMustVerifyNotDecodeRule,
};

export const jwtCookiesPack: IRulePack = {
  id: "jwt-cookies",
  description: "Secure JWT and cookie handling patterns",
  rules,
  rulesConfig: {
    "auth-cookie-must-be-httponly": "error",
    "auth-cookie-must-be-secure-in-prod": "error",
    "auth-cookie-must-set-maxage-or-expires": "warn",
    "auth-cookie-must-set-samesite": "error",
    "bcrypt-rounds-min": "error",
    "jwt-must-verify-not-decode": "error",
  },
};

export default jwtCookiesPack;
