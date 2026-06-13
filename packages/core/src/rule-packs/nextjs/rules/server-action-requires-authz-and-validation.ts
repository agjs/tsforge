import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { walkSome } from "../../utils";
import {
  containsAuthzCall,
  defaultAuthzOptions,
  getFunctionLikeBody,
  hasUseServerDirective,
  isDbMutationCall,
  resolveAuthzFunctions,
  type FunctionLike,
  type IAuthzOptions,
} from "../../authorization/utils";

export const RULE_NAME = "server-action-requires-authz-and-validation";

export interface IServerActionRequiresAuthzAndValidationOptions extends IAuthzOptions {
  readonly parseMethods?: readonly string[];
}

type RuleOptions = [IServerActionRequiresAuthzAndValidationOptions];
type MessageIds = "missingAuthz" | "missingValidation";

const DEFAULT_PARSE_METHODS = ["parse", "safeParse"] as const;

const extendedOptionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    authzFunctions: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
    parseMethods: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
  },
};

function getFunctionName(node: FunctionLike): string {
  if (node.type === AST_NODE_TYPES.FunctionDeclaration && node.id !== null) {
    return node.id.name;
  }

  const parent = node.parent;

  if (
    parent?.type === AST_NODE_TYPES.VariableDeclarator &&
    parent.id.type === AST_NODE_TYPES.Identifier
  ) {
    return parent.id.name;
  }

  return "server action";
}

function containsParseCall(
  root: TSESTree.Node,
  parseMethods: ReadonlySet<string>
): boolean {
  return walkSome(root, (node) => {
    if (node.type !== AST_NODE_TYPES.CallExpression) {
      return false;
    }

    const callee = node.callee;

    if (
      callee.type === AST_NODE_TYPES.MemberExpression &&
      !callee.computed &&
      callee.property.type === AST_NODE_TYPES.Identifier &&
      parseMethods.has(callee.property.name)
    ) {
      return true;
    }

    if (
      callee.type === AST_NODE_TYPES.Identifier &&
      parseMethods.has(callee.name)
    ) {
      return true;
    }

    return false;
  });
}

export const serverActionRequiresAuthzAndValidationRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        'Server actions (`"use server"`) that mutate the database must call authorization helpers and validate input with `.parse()` / `.safeParse()`.',
    },
    schema: [extendedOptionSchema],
    messages: {
      missingAuthz:
        'Server action "{{name}}" performs a database mutation but does not call an authorization helper (e.g. {{examples}}).',
      missingValidation:
        'Server action "{{name}}" performs a database mutation but does not validate input with `.parse()` / `.safeParse()`.',
    },
  },
  defaultOptions: [
    {
      ...defaultAuthzOptions(),
      parseMethods: [...DEFAULT_PARSE_METHODS],
    },
  ],
  create(context, [options]) {
    const authzNames = resolveAuthzFunctions(options);
    const parseMethods = new Set(options.parseMethods ?? DEFAULT_PARSE_METHODS);
    const examples = [...authzNames].slice(0, 2).join(", ");
    let useServerFile = false;

    function visitFunction(node: FunctionLike): void {
      if (!useServerFile) {
        return;
      }

      const body = getFunctionLikeBody(node);

      if (body === null) {
        return;
      }

      const hasMutation = walkSome(
        body,
        (child) =>
          child.type === AST_NODE_TYPES.CallExpression &&
          isDbMutationCall(child)
      );

      if (!hasMutation) {
        return;
      }

      const name = getFunctionName(node);
      const hasAuthz = containsAuthzCall(body, authzNames);
      const hasValidation = containsParseCall(body, parseMethods);

      if (!hasAuthz) {
        context.report({
          node,
          messageId: "missingAuthz",
          data: { name, examples },
        });
      }

      if (!hasValidation) {
        context.report({
          node,
          messageId: "missingValidation",
          data: { name },
        });
      }
    }

    return {
      Program(node: TSESTree.Program) {
        useServerFile = hasUseServerDirective(node);
      },
      FunctionDeclaration: visitFunction,
      FunctionExpression: visitFunction,
      ArrowFunctionExpression: visitFunction,
    };
  },
});
