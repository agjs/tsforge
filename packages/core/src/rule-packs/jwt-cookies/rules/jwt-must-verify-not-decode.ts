import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";

export const RULE_NAME = "jwt-must-verify-not-decode";

export interface IJwtMustVerifyNotDecodeOptions {
  readonly jwtObjectNames?: readonly string[];
  readonly decodeMethods?: readonly string[];
}

type RuleOptions = [IJwtMustVerifyNotDecodeOptions];
type MessageIds = "useVerifyNotDecode";

const DEFAULT_JWT_OBJECTS: readonly string[] = ["jwt", "jsonwebtoken"];
const DEFAULT_DECODE_METHODS: readonly string[] = ["decode", "decodeJwt"];

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    jwtObjectNames: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
    decodeMethods: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
  },
};

function getMemberPropertyName(
  member: TSESTree.MemberExpression
): string | null {
  if (!member.computed && member.property.type === AST_NODE_TYPES.Identifier) {
    return member.property.name;
  }

  if (
    member.computed &&
    member.property.type === AST_NODE_TYPES.Literal &&
    typeof member.property.value === "string"
  ) {
    return member.property.value;
  }

  return null;
}

function isJwtDecodeCall(
  node: TSESTree.CallExpression,
  jwtObjects: ReadonlySet<string>,
  decodeMethods: ReadonlySet<string>
): boolean {
  const callee = node.callee;

  if (callee.type !== AST_NODE_TYPES.MemberExpression || callee.computed) {
    return false;
  }

  const method = getMemberPropertyName(callee);

  if (method === null || !decodeMethods.has(method)) {
    return false;
  }

  const receiver = callee.object;

  if (receiver.type === AST_NODE_TYPES.Identifier) {
    return jwtObjects.has(receiver.name);
  }

  if (
    receiver.type === AST_NODE_TYPES.MemberExpression &&
    !receiver.computed &&
    receiver.property.type === AST_NODE_TYPES.Identifier
  ) {
    return jwtObjects.has(receiver.property.name);
  }

  return false;
}

export const jwtMustVerifyNotDecodeRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `jwt.decode` / `decodeJwt` — decoding without verification accepts forged tokens. Use `jwt.verify` or `jwtVerify` instead.",
    },
    schema: [optionSchema],
    messages: {
      useVerifyNotDecode:
        "Do not decode JWTs without verification — use `jwt.verify(...)` or `jwtVerify(...)` so signatures are checked.",
    },
  },
  defaultOptions: [
    {
      jwtObjectNames: [...DEFAULT_JWT_OBJECTS],
      decodeMethods: [...DEFAULT_DECODE_METHODS],
    },
  ],
  create(context, [options]) {
    const jwtObjects = new Set(options.jwtObjectNames ?? DEFAULT_JWT_OBJECTS);
    const decodeMethods = new Set(
      options.decodeMethods ?? DEFAULT_DECODE_METHODS
    );

    return {
      CallExpression(node) {
        if (isJwtDecodeCall(node, jwtObjects, decodeMethods)) {
          context.report({ node, messageId: "useVerifyNotDecode" });
        }
      },
    };
  },
});
