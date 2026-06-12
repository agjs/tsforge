import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  collectElysiaVariables,
  findEnclosingRouteHandler,
  findObjectProperty,
  isElysiaRouteCall,
} from "../utils/elysiaChain";

export const RULE_NAME = "prefer-direct-return";

export interface PreferDirectReturnOptions {
  readonly allowWithHeaders?: boolean;
}

type RuleOptions = [PreferDirectReturnOptions];
type MessageIds = "preferDirectReturn";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    allowWithHeaders: { type: "boolean" },
  },
};

export const preferDirectReturnRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Inside Elysia route handlers, return values directly instead of wrapping them in `new Response(...)` or `Response.json(...)` — Elysia handles serialization and content-type automatically.",
    },
    schema: [optionSchema],
    messages: {
      preferDirectReturn:
        "Return the value directly — Elysia will serialize it and set the correct content-type. Wrapping in `new Response(...)` is only necessary for streams or custom headers.",
    },
  },
  defaultOptions: [{ allowWithHeaders: true }],
  create(context, [options]) {
    const allowWithHeaders = options.allowWithHeaders !== false;
    let elysiaVars = new Set<string>();

    return {
      Program(program) {
        elysiaVars = collectElysiaVariables(program);
      },
      ReturnStatement(node) {
        if (!node.argument) {
          return;
        }

        if (!findEnclosingRouteHandler(node, elysiaVars)) {
          return;
        }

        checkExpression(node.argument);
      },
      ArrowFunctionExpression(node) {
        if (node.body.type === AST_NODE_TYPES.BlockStatement) {
          return;
        }

        if (!isRouteHandlerArg(node, elysiaVars)) {
          return;
        }

        checkExpression(node.body);
      },
    };

    function checkExpression(arg: TSESTree.Expression): void {
      if (arg.type === AST_NODE_TYPES.NewExpression) {
        if (
          arg.callee.type !== AST_NODE_TYPES.Identifier ||
          arg.callee.name !== "Response"
        ) {
          return;
        }

        const bodyArg = arg.arguments[0];

        if (!bodyArg || !isSimpleBody(bodyArg)) {
          return;
        }

        const optionsArg = arg.arguments[1];

        if (
          allowWithHeaders &&
          optionsArg &&
          hasHeadersOrContentType(optionsArg)
        ) {
          return;
        }

        context.report({ node: arg, messageId: "preferDirectReturn" });

        return;
      }

      if (
        arg.type === AST_NODE_TYPES.CallExpression &&
        arg.callee.type === AST_NODE_TYPES.MemberExpression &&
        arg.callee.object.type === AST_NODE_TYPES.Identifier &&
        arg.callee.object.name === "Response" &&
        arg.callee.property.type === AST_NODE_TYPES.Identifier &&
        arg.callee.property.name === "json"
      ) {
        context.report({ node: arg, messageId: "preferDirectReturn" });
      }
    }
  },
});

function isRouteHandlerArg(
  fn: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression,
  elysiaVars: Set<string>
): boolean {
  const parent = fn.parent;

  if (parent?.type !== AST_NODE_TYPES.CallExpression) {
    return false;
  }

  if (!parent.arguments.includes(fn)) {
    return false;
  }

  return isElysiaRouteCall(parent, elysiaVars);
}

function isSimpleBody(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.SpreadElement) {
    return false;
  }

  if (
    node.type === AST_NODE_TYPES.Literal ||
    node.type === AST_NODE_TYPES.TemplateLiteral
  ) {
    return true;
  }

  if (
    node.type === AST_NODE_TYPES.CallExpression &&
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.object.type === AST_NODE_TYPES.Identifier &&
    node.callee.object.name === "JSON" &&
    node.callee.property.type === AST_NODE_TYPES.Identifier &&
    node.callee.property.name === "stringify"
  ) {
    return true;
  }

  if (
    node.type === AST_NODE_TYPES.ObjectExpression ||
    node.type === AST_NODE_TYPES.ArrayExpression
  ) {
    return true;
  }

  return false;
}

function hasHeadersOrContentType(opts: TSESTree.Node): boolean {
  if (opts.type !== AST_NODE_TYPES.ObjectExpression) {
    return false;
  }

  return findObjectProperty(opts, "headers") !== null;
}
