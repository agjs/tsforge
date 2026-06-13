import { AST_NODE_TYPES } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { walkSome } from "../../utils";
import {
  authzOptionSchema,
  containsAuthzCall,
  defaultAuthzOptions,
  getFunctionLikeBody,
  isDbQueryCall,
  isParamsIdRead,
  resolveAuthzFunctions,
  type AuthzRuleOptions,
  type FunctionLike,
} from "../utils";

export const RULE_NAME = "id-param-requires-object-authz";

type MessageIds = "missingObjectAuthz";

function analyzeFunction(
  node: FunctionLike,
  authzNames: Set<string>
): { hasParamsId: boolean; hasDbQuery: boolean; hasAuthz: boolean } {
  const body = getFunctionLikeBody(node);

  if (body === null) {
    return { hasParamsId: false, hasDbQuery: false, hasAuthz: false };
  }

  return {
    hasParamsId: walkSome(body, isParamsIdRead),
    hasDbQuery: walkSome(body, (child) => {
      if (child.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }

      return isDbQueryCall(child);
    }),
    hasAuthz: containsAuthzCall(body, authzNames),
  };
}

export const idParamRequiresObjectAuthzRule = createRule<
  AuthzRuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Warn when a handler reads `params.id` and queries the database without an authorization check in the same function.",
    },
    schema: [authzOptionSchema],
    messages: {
      missingObjectAuthz:
        "Reading `params.id` and querying the database in the same function requires object-level authorization (e.g. {{examples}}).",
    },
  },
  defaultOptions: [defaultAuthzOptions()],
  create(context, [options]) {
    const authzNames = resolveAuthzFunctions(options);
    const examples = [...authzNames].slice(0, 2).join(", ");

    function visitFunction(node: FunctionLike): void {
      const { hasParamsId, hasDbQuery, hasAuthz } = analyzeFunction(
        node,
        authzNames
      );

      if (hasParamsId && hasDbQuery && !hasAuthz) {
        context.report({
          node,
          messageId: "missingObjectAuthz",
          data: { examples },
        });
      }
    }

    return {
      FunctionDeclaration: visitFunction,
      FunctionExpression: visitFunction,
      ArrowFunctionExpression: visitFunction,
    };
  },
});
