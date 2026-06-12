import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-nested-db-transaction";

export interface NoNestedDbTransactionOptions {
  readonly transactionMethod?: string;
}

type RuleOptions = [NoNestedDbTransactionOptions];
type MessageIds = "nestedTransaction";

const DEFAULT_TRANSACTION_METHOD = "transaction";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    transactionMethod: {
      type: "string",
      minLength: 1,
    },
  },
};

export const noNestedDbTransactionRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid invoking the outer db's `.transaction(...)` method inside a transaction callback — use the callback's `tx` parameter instead to avoid deadlocks.",
    },
    schema: [optionSchema],
    messages: {
      nestedTransaction:
        "Nested call to `{{receiver}}.{{method}}(...)` inside a transaction callback — use the callback's transaction parameter (`tx.{{method}}(...)`) instead. Calling the original db inside an open transaction deadlocks or silently fails.",
    },
  },
  defaultOptions: [{ transactionMethod: DEFAULT_TRANSACTION_METHOD }],
  create(context, [options]) {
    const transactionMethod =
      options.transactionMethod ?? DEFAULT_TRANSACTION_METHOD;

    const callbackParamStack: string[] = [];

    function isTransactionCall(node: TSESTree.CallExpression): boolean {
      return (
        node.callee.type === AST_NODE_TYPES.MemberExpression &&
        node.callee.property.type === AST_NODE_TYPES.Identifier &&
        node.callee.property.name === transactionMethod
      );
    }

    function getReceiverName(node: TSESTree.CallExpression): string | null {
      if (
        node.callee.type === AST_NODE_TYPES.MemberExpression &&
        node.callee.object.type === AST_NODE_TYPES.Identifier
      ) {
        return node.callee.object.name;
      }

      return null;
    }

    function getCallbackParamName(
      node: TSESTree.CallExpression
    ): string | null {
      const arg = node.arguments[0];

      if (
        !arg ||
        (arg.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
          arg.type !== AST_NODE_TYPES.FunctionExpression)
      ) {
        return null;
      }

      const firstParam = arg.params[0];

      if (firstParam?.type === AST_NODE_TYPES.Identifier) {
        return firstParam.name;
      }

      return null;
    }

    return {
      CallExpression(node) {
        if (!isTransactionCall(node)) {
          return;
        }

        if (callbackParamStack.length > 0) {
          const receiverName = getReceiverName(node);

          if (
            receiverName !== null &&
            !callbackParamStack.includes(receiverName)
          ) {
            context.report({
              node,
              messageId: "nestedTransaction",
              data: {
                receiver: receiverName,
                method: transactionMethod,
              },
            });
          }
        }

        const paramName = getCallbackParamName(node);

        callbackParamStack.push(paramName ?? "");
      },
      "CallExpression:exit"(node: TSESTree.CallExpression) {
        if (!isTransactionCall(node)) {
          return;
        }

        callbackParamStack.pop();
      },
    };
  },
});
