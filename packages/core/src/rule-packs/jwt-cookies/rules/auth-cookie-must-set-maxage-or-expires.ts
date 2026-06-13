import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  DEFAULT_AUTH_COOKIE_NAMES,
  DEFAULT_SET_COOKIE_FUNCTIONS,
  DEFAULT_TRUSTED_CONFIG_NAMES,
  lookupCookieOption,
  matchAuthCookieSet,
} from "../utils";

export const RULE_NAME = "auth-cookie-must-set-maxage-or-expires";

export interface IAuthCookieMustSetMaxAgeOrExpiresOptions {
  readonly authCookieNames?: readonly string[];
  readonly trustedConfigNames?: readonly string[];
  readonly setCookieFunctions?: readonly string[];
}

type RuleOptions = [IAuthCookieMustSetMaxAgeOrExpiresOptions];
type MessageIds = "missingLifetime";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    authCookieNames: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
    trustedConfigNames: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
    setCookieFunctions: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
  },
};

export const authCookieMustSetMaxAgeOrExpiresRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Auth-cookie writes should set `maxAge` or `expires` so session cookies do not live forever by default.",
    },
    schema: [optionSchema],
    messages: {
      missingLifetime:
        "Auth cookie '{{name}}' missing `maxAge` or `expires` — session cookies without a lifetime persist until cleared.",
    },
  },
  defaultOptions: [
    {
      authCookieNames: [...DEFAULT_AUTH_COOKIE_NAMES],
      trustedConfigNames: [...DEFAULT_TRUSTED_CONFIG_NAMES],
      setCookieFunctions: [...DEFAULT_SET_COOKIE_FUNCTIONS],
    },
  ],
  create(context, [options]) {
    const authCookieNames = new Set(
      options.authCookieNames ?? DEFAULT_AUTH_COOKIE_NAMES
    );
    const trustedConfigNames = new Set(
      options.trustedConfigNames ?? DEFAULT_TRUSTED_CONFIG_NAMES
    );
    const setCookieFunctions = new Set(
      options.setCookieFunctions ?? DEFAULT_SET_COOKIE_FUNCTIONS
    );

    return {
      CallExpression(node) {
        const match = matchAuthCookieSet(
          node,
          authCookieNames,
          setCookieFunctions
        );

        if (match === null) {
          return;
        }

        if (match.optionsNode === null) {
          context.report({
            node,
            messageId: "missingLifetime",
            data: { name: match.cookieName },
          });

          return;
        }

        const maxAge = lookupCookieOption(
          match.optionsNode,
          "maxAge",
          trustedConfigNames
        );
        const expires = lookupCookieOption(
          match.optionsNode,
          "expires",
          trustedConfigNames
        );

        if (
          maxAge.hasTrustedSpread ||
          expires.hasTrustedSpread ||
          maxAge.value !== null ||
          expires.value !== null
        ) {
          return;
        }

        context.report({
          node,
          messageId: "missingLifetime",
          data: { name: match.cookieName },
        });
      },
    };
  },
});
