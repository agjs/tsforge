import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { walkSome } from "../../utils";
import {
  collectElysiaVariables,
  findEnclosingRouteHandler,
} from "../utils/elysiaChain";

export const RULE_NAME = "prefer-static-services";

export interface PreferStaticServicesOptions {
  readonly classNamePattern?: string;
}

type RuleOptions = [PreferStaticServicesOptions];
type MessageIds = "preferStaticService";

const DEFAULT_PATTERN = "(Service|Controller|Manager|Repository)$";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    classNamePattern: { type: "string", minLength: 1 },
  },
};

export const preferStaticServicesRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Discourage `new Service()` inside Elysia route handlers when the class is stateless — prefer static methods or a singleton.",
    },
    schema: [optionSchema],
    messages: {
      preferStaticService:
        "Avoid `new {{name}}()` inside an Elysia route handler — '{{name}}' has no instance state, so allocating per request is wasteful. Use static methods or a module-level singleton.",
    },
  },
  defaultOptions: [{ classNamePattern: DEFAULT_PATTERN }],
  create(context, [options]) {
    const pattern = compilePattern(options.classNamePattern ?? DEFAULT_PATTERN);

    if (!pattern) {
      return {};
    }

    let elysiaVars = new Set<string>();
    const classes = new Map<string, TSESTree.ClassDeclaration>();
    const newExpressions: TSESTree.NewExpression[] = [];

    return {
      Program(program) {
        elysiaVars = collectElysiaVariables(program);
      },
      ClassDeclaration(node) {
        if (node.id) {
          classes.set(node.id.name, node);
        }
      },
      NewExpression(node) {
        if (node.callee.type !== AST_NODE_TYPES.Identifier) {
          return;
        }

        if (!pattern.test(node.callee.name)) {
          return;
        }

        newExpressions.push(node);
      },
      "Program:exit"() {
        for (const newExpr of newExpressions) {
          if (newExpr.callee.type !== AST_NODE_TYPES.Identifier) {
            continue;
          }

          const className = newExpr.callee.name;
          const classDecl = classes.get(className);

          if (!classDecl || !isStateless(classDecl)) {
            continue;
          }

          if (!findEnclosingRouteHandler(newExpr, elysiaVars)) {
            continue;
          }

          context.report({
            node: newExpr,
            messageId: "preferStaticService",
            data: { name: className },
          });
        }
      },
    };
  },
});

function isStateless(node: TSESTree.ClassDeclaration): boolean {
  return node.body.body.every(memberIsStateless);
}

function memberIsStateless(member: TSESTree.ClassElement): boolean {
  if (member.type === AST_NODE_TYPES.PropertyDefinition) {
    return member.static;
  }

  if (member.type !== AST_NODE_TYPES.MethodDefinition) {
    return true;
  }

  if (member.kind === "constructor" && constructorHasState(member.value)) {
    return false;
  }

  return (
    member.static ||
    member.value.type === AST_NODE_TYPES.TSEmptyBodyFunctionExpression ||
    !assignsToThis(member.value)
  );
}

function constructorHasState(
  ctor: TSESTree.FunctionExpression | TSESTree.TSEmptyBodyFunctionExpression
): boolean {
  if (
    ctor.body?.type === AST_NODE_TYPES.BlockStatement &&
    ctor.body.body.length > 0
  ) {
    return true;
  }

  return ctor.params.some(
    (param) => param.type === AST_NODE_TYPES.TSParameterProperty
  );
}

function assignsToThis(fn: TSESTree.FunctionExpression): boolean {
  return walkSome(
    fn.body,
    (node) =>
      node.type === AST_NODE_TYPES.AssignmentExpression &&
      node.left.type === AST_NODE_TYPES.MemberExpression &&
      node.left.object.type === AST_NODE_TYPES.ThisExpression
  );
}

function compilePattern(source: string): RegExp | null {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}
