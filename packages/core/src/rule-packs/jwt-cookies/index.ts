import type { TSESLint } from "@typescript-eslint/utils";

import { authCookieMustBeHttpOnlyRule } from "./rules/auth-cookie-must-be-httponly";
import { authCookieMustBeSecureInProdRule } from "./rules/auth-cookie-must-be-secure-in-prod";
import { bcryptRoundsMinRule } from "./rules/bcrypt-rounds-min";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "auth-cookie-must-be-httponly": authCookieMustBeHttpOnlyRule,
  "auth-cookie-must-be-secure-in-prod": authCookieMustBeSecureInProdRule,
  "bcrypt-rounds-min": bcryptRoundsMinRule,
};

export const jwtCookiesPack: IRulePack = {
  id: "jwt-cookies",
  description: "Secure JWT and cookie handling patterns",
  rules,
  rulesConfig: {
    "auth-cookie-must-be-httponly": "error",
    "auth-cookie-must-be-secure-in-prod": "error",
    "bcrypt-rounds-min": "error",
  },
};

export default jwtCookiesPack;
