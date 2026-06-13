import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { isServerAppFile } from "../utils";

export const RULE_NAME = "no-secret-props-to-client";

export interface INoSecretPropsToClientOptions {
  readonly secretPropPatterns?: readonly string[];
}

type RuleOptions = [INoSecretPropsToClientOptions];
type MessageIds = "secretPropToClient";

const DEFAULT_SECRET_PROP_PATTERNS = [
  "secret",
  "password",
  "token",
  "apiKey",
  "api_key",
  "privateKey",
  "private_key",
  "credential",
  "authToken",
  "accessToken",
  "refreshToken",
] as const;

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    secretPropPatterns: {
      type: "array",
      items: { type: "string", minLength: 1 },
      uniqueItems: true,
      minItems: 1,
    },
  },
};

function propNameLooksSecret(
  name: string,
  patterns: readonly string[]
): boolean {
  const lower = name.toLowerCase();

  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

function getJsxAttributeName(
  attribute: TSESTree.JSXAttribute | TSESTree.JSXSpreadAttribute
): string | null {
  if (attribute.type === AST_NODE_TYPES.JSXSpreadAttribute) {
    return null;
  }

  const name = attribute.name;

  if (name.type === AST_NODE_TYPES.JSXIdentifier) {
    return name.name;
  }

  if (name.type === AST_NODE_TYPES.JSXNamespacedName) {
    return name.name.name;
  }

  return null;
}

export const noSecretPropsToClientRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Warn when Server Components pass secret-looking props to JSX — values may cross the client boundary.",
    },
    schema: [optionSchema],
    messages: {
      secretPropToClient:
        "Prop `{{name}}` looks like a secret — do not pass it from Server Components to client-rendered JSX.",
    },
  },
  defaultOptions: [{ secretPropPatterns: [...DEFAULT_SECRET_PROP_PATTERNS] }],
  create(context, [options]) {
    const patterns = options.secretPropPatterns ?? DEFAULT_SECRET_PROP_PATTERNS;
    let serverFile = false;

    return {
      Program(node: TSESTree.Program) {
        serverFile = isServerAppFile(context.filename, node);
      },
      JSXOpeningElement(node) {
        if (!serverFile) {
          return;
        }

        for (const attr of node.attributes) {
          const propName = getJsxAttributeName(attr);

          if (propName === null) {
            continue;
          }

          if (propNameLooksSecret(propName, patterns)) {
            context.report({
              node: attr,
              messageId: "secretPropToClient",
              data: { name: propName },
            });
          }
        }
      },
    };
  },
});
