import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  HOOK_METHODS,
  ROUTE_METHODS,
  collectElysiaVariables,
  getChainRoot,
  getMemberMethodName,
  isElysiaRouted,
  isNewElysiaExpression,
} from "../utils/elysiaChain";

export const RULE_NAME = "require-hooks-before-routes";

export interface RequireHooksBeforeRoutesOptions {
  readonly hooks?: readonly string[];
  readonly routes?: readonly string[];
}

type RuleOptions = [RequireHooksBeforeRoutesOptions];
type MessageIds = "hookAfterRoute";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    hooks: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
    routes: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
  },
};

export const requireHooksBeforeRoutesRule = createRule<RuleOptions, MessageIds>(
  {
    name: RULE_NAME,
    meta: {
      type: "problem",
      docs: {
        description:
          "Elysia hooks (onError, onBeforeHandle, etc.) must register before any route methods on the same instance — top-down waterfall semantics mean a hook registered after a route does not apply to it.",
      },
      schema: [optionSchema],
      messages: {
        hookAfterRoute:
          "Hook `.{{hook}}(...)` registered after route `.{{route}}(...)` — the hook will NOT apply to that earlier route. Move global hooks before any route on the same instance.",
      },
    },
    defaultOptions: [
      {
        hooks: [...HOOK_METHODS],
        routes: [...ROUTE_METHODS],
      },
    ],
    create(context, [options]) {
      const hooks = new Set(options.hooks ?? HOOK_METHODS);
      const routes = new Set(options.routes ?? ROUTE_METHODS);

      let elysiaVars = new Set<string>();
      const flatBuilderCalls = new Map<string, OrderedCall[]>();
      const reportedNodes = new WeakSet();

      function reportFlatBuilders(): void {
        for (const calls of flatBuilderCalls.values()) {
          const firstRouteIndex = calls.findIndex((c) => routes.has(c.method));

          if (firstRouteIndex === -1) {
            continue;
          }

          const firstRoute = calls[firstRouteIndex];

          for (let i = firstRouteIndex + 1; i < calls.length; i++) {
            const call = calls[i];

            if (!call) {
              continue;
            }

            if (
              hooks.has(call.method) &&
              firstRoute &&
              !reportedNodes.has(call.node)
            ) {
              reportedNodes.add(call.node);
              context.report({
                node: call.node,
                messageId: "hookAfterRoute",
                data: { hook: call.method, route: firstRoute.method },
              });
            }
          }
        }
      }

      function reportChain(rootCall: TSESTree.CallExpression): void {
        const ordered = collectChainCalls(rootCall);

        const firstRouteIndex = ordered.findIndex((c) => routes.has(c.method));

        if (firstRouteIndex === -1) {
          return;
        }

        const firstRoute = ordered[firstRouteIndex];

        for (let i = firstRouteIndex + 1; i < ordered.length; i++) {
          const call = ordered[i];

          if (!call) {
            continue;
          }

          if (
            hooks.has(call.method) &&
            firstRoute &&
            !reportedNodes.has(call.node)
          ) {
            reportedNodes.add(call.node);
            context.report({
              node: call.node,
              messageId: "hookAfterRoute",
              data: { hook: call.method, route: firstRoute.method },
            });
          }
        }
      }

      return {
        Program(program) {
          elysiaVars = collectElysiaVariables(program);
        },
        CallExpression(node) {
          if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
            return;
          }

          const method = getMemberMethodName(node);

          if (!method) {
            return;
          }

          if (!isElysiaRouted(node, elysiaVars)) {
            return;
          }

          const root = getChainRoot(node);

          if (isNewElysiaExpression(root)) {
            if (
              node.parent?.type === AST_NODE_TYPES.MemberExpression &&
              node.parent.parent?.type === AST_NODE_TYPES.CallExpression &&
              isElysiaRouted(node.parent.parent, elysiaVars)
            ) {
              return;
            }

            reportChain(node);

            return;
          }

          if (
            root.type === AST_NODE_TYPES.Identifier &&
            elysiaVars.has(root.name)
          ) {
            const list = flatBuilderCalls.get(root.name) ?? [];

            list.push({ method, node });
            flatBuilderCalls.set(root.name, list);
          }
        },
        "Program:exit"() {
          reportFlatBuilders();
        },
      };
    },
  }
);

interface OrderedCall {
  readonly method: string;
  readonly node: TSESTree.CallExpression;
}

function collectChainCalls(outermost: TSESTree.CallExpression): OrderedCall[] {
  const calls: OrderedCall[] = [];
  let current: TSESTree.Expression = outermost;

  while (
    current.type === AST_NODE_TYPES.CallExpression &&
    current.callee.type === AST_NODE_TYPES.MemberExpression &&
    current.callee.property.type === AST_NODE_TYPES.Identifier
  ) {
    calls.push({ method: current.callee.property.name, node: current });
    current = current.callee.object;
  }

  return calls.reverse();
}
