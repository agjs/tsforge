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

export const RULE_NAME = "auth-cookie-must-be-httponly";

export interface AuthCookieMustBeHttpOnlyOptions {
  readonly authCookieNames?: readonly string[];
  readonly trustedConfigNames?: readonly string[];
  readonly setCookieFunctions?: readonly string[];
}

type RuleOptions = [AuthCookieMustBeHttpOnlyOptions];
type MessageIds = "missingHttpOnly";

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

export const authCookieMustBeHttpOnlyRule = createRule<RuleOptions, MessageIds>(
  {
    name: RULE_NAME,
    meta: {
      type: "problem",
      docs: {
        description:
          "Auth-cookie writes must set `httpOnly: true` (or spread a trusted cookie-config helper). JS-readable session cookies leak via XSS.",
      },
      schema: [optionSchema],
      messages: {
        missingHttpOnly:
          "Auth cookie '{{name}}' missing `httpOnly: true` — JS-readable cookies leak via XSS.",
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
              messageId: "missingHttpOnly",
              data: { name: match.cookieName },
            });

            return;
          }

          const { value, hasTrustedSpread } = lookupCookieOption(
            match.optionsNode,
            "httpOnly",
            trustedConfigNames
          );

          if (hasTrustedSpread) {
            // Spreads a trusted helper — assume it sets httpOnly correctly.
            // If `httpOnly` is also explicitly present, require it to be `true`.
            if (
              value !== null &&
              value.type === AST_NODE_TYPES.Literal &&
              value.value === false
            ) {
              context.report({
                node: value,
                messageId: "missingHttpOnly",
                data: { name: match.cookieName },
              });
            }

            return;
          }

          if (value === null) {
            context.report({
              node,
              messageId: "missingHttpOnly",
              data: { name: match.cookieName },
            });

            return;
          }

          // Literal `true` ok. Literal `false` flagged. Anything else (env-derived
          // expression, identifier) is conservatively accepted.
          if (value.type === AST_NODE_TYPES.Literal && value.value !== true) {
            context.report({
              node: value,
              messageId: "missingHttpOnly",
              data: { name: match.cookieName },
            });
          }
        },
      };
    },
  }
);
