import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { walkSome } from "../../utils";
import {
  authzOptionSchema,
  containsAuthzCall,
  defaultAuthzOptions,
  getFunctionLikeBody,
  hasUseServerDirective,
  isDbMutationCall,
  resolveAuthzFunctions,
  type AuthzRuleOptions,
  type FunctionLike,
} from "../utils";

export const RULE_NAME = "server-action-requires-authz";

type MessageIds = "missingAuthz";

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

export const serverActionRequiresAuthzRule = createRule<
  AuthzRuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        'Files with `"use server"` that perform database mutations must call an authorization helper in the same function.',
    },
    schema: [authzOptionSchema],
    messages: {
      missingAuthz:
        'Server action "{{name}}" performs a database mutation but does not call an authorization helper (e.g. {{examples}}).',
    },
  },
  defaultOptions: [defaultAuthzOptions()],
  create(context, [options]) {
    const authzNames = resolveAuthzFunctions(options);
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
      const hasAuthz = containsAuthzCall(body, authzNames);

      if (hasMutation && !hasAuthz) {
        context.report({
          node,
          messageId: "missingAuthz",
          data: {
            name: getFunctionName(node),
            examples,
          },
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
