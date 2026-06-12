import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { pushChildNodes } from "../../utils";
import {
  collectElysiaVariables,
  getRouteHandlerFunction,
  isElysiaRouteCall,
} from "../utils/elysiaChain";

export const RULE_NAME = "prefer-destructured-context";

export interface PreferDestructuredContextOptions {
  readonly allowNames?: readonly string[];
}

type RuleOptions = [PreferDestructuredContextOptions];
type MessageIds = "preferDestructuredContext";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    allowNames: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
  },
};

export const preferDestructuredContextRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer destructured context (`{ body, set, ... }`) over passing the entire dynamic Elysia context object into controllers/services.",
    },
    schema: [optionSchema],
    messages: {
      preferDestructuredContext:
        "Do not pass the full Elysia context (`{{name}}`) into another function. Destructure only the properties you need at the route boundary.",
    },
  },
  defaultOptions: [{ allowNames: [] }],
  create(context, [options]) {
    const allowNames = new Set(options.allowNames ?? []);
    let elysiaVars = new Set<string>();

    return {
      Program(program) {
        elysiaVars = collectElysiaVariables(program);
      },
      CallExpression(node) {
        if (!isElysiaRouteCall(node, elysiaVars)) {
          return;
        }

        const handler = getRouteHandlerFunction(node);

        if (handler?.params.length !== 1) {
          return;
        }

        const param = handler.params[0];

        if (param?.type !== AST_NODE_TYPES.Identifier) {
          return;
        }

        if (allowNames.has(param.name)) {
          return;
        }

        const ctxName = param.name;

        for (const violation of collectContextPassThrough(
          handler.body,
          ctxName
        )) {
          context.report({
            node: violation,
            messageId: "preferDestructuredContext",
            data: { name: ctxName },
          });
        }
      },
    };
  },
});

function isFunctionNode(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionDeclaration
  );
}

/** True when a call/new expression forwards `ctxName` (directly or spread). */
function callPassesContext(
  call: TSESTree.CallExpression | TSESTree.NewExpression,
  ctxName: string
): boolean {
  return call.arguments.some((arg) => {
    if (arg.type === AST_NODE_TYPES.Identifier) {
      return arg.name === ctxName;
    }

    return (
      arg.type === AST_NODE_TYPES.SpreadElement &&
      arg.argument.type === AST_NODE_TYPES.Identifier &&
      arg.argument.name === ctxName
    );
  });
}

/** Calls inside the handler body (excluding nested functions) that forward the context. */
function collectContextPassThrough(
  root: TSESTree.Node,
  ctxName: string
): TSESTree.Node[] {
  const violations: TSESTree.Node[] = [];
  const stack: TSESTree.Node[] = [root];
  const visited = new WeakSet();

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (visited.has(node)) {
      continue;
    }

    visited.add(node);

    if (isFunctionNode(node) && node !== root) {
      continue;
    }

    if (
      (node.type === AST_NODE_TYPES.CallExpression ||
        node.type === AST_NODE_TYPES.NewExpression) &&
      callPassesContext(node, ctxName)
    ) {
      violations.push(node);
    }

    pushChildNodes(node, stack);
  }

  return violations;
}
