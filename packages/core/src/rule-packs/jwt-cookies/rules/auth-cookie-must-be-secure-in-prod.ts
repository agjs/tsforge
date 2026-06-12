import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  DEFAULT_AUTH_COOKIE_NAMES,
  DEFAULT_SET_COOKIE_FUNCTIONS,
  DEFAULT_TRUSTED_CONFIG_NAMES,
  lookupCookieOption,
  matchAuthCookieSet,
} from "../utils";

export const RULE_NAME = "auth-cookie-must-be-secure-in-prod";

export interface AuthCookieMustBeSecureInProdOptions {
  readonly authCookieNames?: readonly string[];
  readonly trustedConfigNames?: readonly string[];
  readonly setCookieFunctions?: readonly string[];
}

type RuleOptions = [AuthCookieMustBeSecureInProdOptions];
type MessageIds = "missingSecure";

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

export const authCookieMustBeSecureInProdRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Auth-cookie writes must set `secure:` to `true` or an env-derived expression (anything non-literal). Cookies leak over HTTP without it.",
    },
    schema: [optionSchema],
    messages: {
      missingSecure:
        "Auth cookie '{{name}}' missing `secure:` — cookies leak over HTTP in transit.",
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
            messageId: "missingSecure",
            data: { name: match.cookieName },
          });

          return;
        }

        const { value, hasTrustedSpread } = lookupCookieOption(
          match.optionsNode,
          "secure",
          trustedConfigNames
        );

        if (hasTrustedSpread) {
          if (
            value !== null &&
            value.type === AST_NODE_TYPES.Literal &&
            value.value === false
          ) {
            context.report({
              node: value,
              messageId: "missingSecure",
              data: { name: match.cookieName },
            });
          }

          return;
        }

        if (value === null) {
          context.report({
            node,
            messageId: "missingSecure",
            data: { name: match.cookieName },
          });

          return;
        }

        // Literal `false` is a hard fail. Literal `true` ok. Any non-literal
        // (env-derived) is accepted on trust.
        if (value.type === AST_NODE_TYPES.Literal && value.value !== true) {
          context.report({
            node: value,
            messageId: "missingSecure",
            data: { name: match.cookieName },
          });
        }
      },
    };
  },
});
