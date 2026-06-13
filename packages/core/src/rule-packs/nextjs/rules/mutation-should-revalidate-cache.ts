import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { walkSome } from "../../utils";
import {
  getFunctionLikeBody,
  hasUseServerDirective,
  isDbMutationCall,
  isRouteHandlerFile,
  type FunctionLike,
} from "../../authorization/utils";

export const RULE_NAME = "mutation-should-revalidate-cache";

export interface IMutationShouldRevalidateCacheOptions {
  readonly revalidateFunctions?: readonly string[];
}

type RuleOptions = [IMutationShouldRevalidateCacheOptions];
type MessageIds = "missingRevalidation";

const DEFAULT_REVALIDATE_FUNCTIONS = [
  "revalidatePath",
  "revalidateTag",
] as const;

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    revalidateFunctions: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
  },
};

function containsRevalidateCall(
  root: TSESTree.Node,
  names: ReadonlySet<string>
): boolean {
  return walkSome(root, (node) => {
    if (node.type !== AST_NODE_TYPES.CallExpression) {
      return false;
    }

    const callee = node.callee;

    if (callee.type === AST_NODE_TYPES.Identifier) {
      return names.has(callee.name);
    }

    if (
      callee.type === AST_NODE_TYPES.MemberExpression &&
      !callee.computed &&
      callee.property.type === AST_NODE_TYPES.Identifier
    ) {
      return names.has(callee.property.name);
    }

    return false;
  });
}

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

  return "handler";
}

export const mutationShouldRevalidateCacheRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "After database mutations in server actions or route handlers, call `revalidatePath` or `revalidateTag` so cached pages reflect the change.",
    },
    schema: [optionSchema],
    messages: {
      missingRevalidation:
        "{{name}} mutates data but does not call `revalidatePath` or `revalidateTag` — stale cached pages may be served.",
    },
  },
  defaultOptions: [{ revalidateFunctions: [...DEFAULT_REVALIDATE_FUNCTIONS] }],
  create(context, [options]) {
    const revalidateFunctions = new Set(
      options.revalidateFunctions ?? DEFAULT_REVALIDATE_FUNCTIONS
    );
    let useServerFile = false;
    const isRouteHandler = isRouteHandlerFile(context.filename);

    function visitFunction(node: FunctionLike): void {
      if (!useServerFile && !isRouteHandler) {
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

      if (containsRevalidateCall(body, revalidateFunctions)) {
        return;
      }

      context.report({
        node,
        messageId: "missingRevalidation",
        data: { name: getFunctionName(node) },
      });
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
