import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { calleeName, isServerAppFile } from "../utils";

export const RULE_NAME = "await-dynamic-request-apis";

type MessageIds = "mustAwait";

const DYNAMIC_REQUEST_APIS = new Set(["cookies", "headers", "draftMode"]);

function isAwaited(node: TSESTree.Node): boolean {
  let current: TSESTree.Node | null | undefined = node.parent;

  while (current !== undefined && current !== null) {
    if (current.type === AST_NODE_TYPES.AwaitExpression) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

export const awaitDynamicRequestApisRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Require awaiting Next.js dynamic request APIs (cookies, headers, draftMode) in app-router Server Components.",
    },
    schema: [],
    messages: {
      mustAwait:
        "`{{api}}()` must be awaited in Server Components — use `await {{api}}()` (Next.js 15+ async request APIs).",
    },
  },
  defaultOptions: [],
  create(context) {
    let serverFile = false;

    return {
      Program(node: TSESTree.Program) {
        serverFile = isServerAppFile(context.filename, node);
      },
      CallExpression(node: TSESTree.CallExpression) {
        if (!serverFile || isAwaited(node)) {
          return;
        }

        const name = calleeName(node.callee);

        if (name !== null && DYNAMIC_REQUEST_APIS.has(name)) {
          context.report({
            node,
            messageId: "mustAwait",
            data: { api: name },
          });
        }
      },
    };
  },
});
