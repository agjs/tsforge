import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { isExpression, isIdentifierNamed } from "../../boundary-utils";
import { createRule } from "../../create-rule";

export const RULE_NAME = "no-prototype-polluting-merge";

type MessageIds = "prototypePollutingMerge";

const REQUEST_FIELD_NAMES = new Set(["body", "query", "params"]);
const REQUEST_OBJECT_NAMES = new Set(["req", "request", "ctx"]);

function isRequestFieldExpression(node: TSESTree.Expression): boolean {
  if (isIdentifierNamed(node, "body")) {
    return true;
  }

  if (isIdentifierNamed(node, "query")) {
    return true;
  }

  if (isIdentifierNamed(node, "params")) {
    return true;
  }

  if (node.type !== AST_NODE_TYPES.MemberExpression || node.computed) {
    return false;
  }

  const property = node.property;

  if (
    property.type !== AST_NODE_TYPES.Identifier ||
    !REQUEST_FIELD_NAMES.has(property.name)
  ) {
    return false;
  }

  const object = node.object;

  return (
    object.type === AST_NODE_TYPES.Identifier &&
    REQUEST_OBJECT_NAMES.has(object.name)
  );
}

function isObjectAssignWithRequestFields(
  node: TSESTree.CallExpression
): boolean {
  const callee = node.callee;

  if (
    callee.type !== AST_NODE_TYPES.MemberExpression ||
    callee.computed ||
    callee.object.type !== AST_NODE_TYPES.Identifier ||
    callee.object.name !== "Object" ||
    callee.property.type !== AST_NODE_TYPES.Identifier ||
    callee.property.name !== "assign"
  ) {
    return false;
  }

  return node.arguments.some((arg, index) => {
    if (index === 0 || !isExpression(arg)) {
      return false;
    }

    return isRequestFieldExpression(arg);
  });
}

function objectHasRequestFieldSpread(node: TSESTree.ObjectExpression): boolean {
  return node.properties.some((prop) => {
    if (prop.type !== AST_NODE_TYPES.SpreadElement) {
      return false;
    }

    const argument = prop.argument;

    return isExpression(argument) && isRequestFieldExpression(argument);
  });
}

export const noPrototypePollutingMergeRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow merging request body/query/params into objects — enables prototype pollution.",
    },
    schema: [],
    messages: {
      prototypePollutingMerge:
        "Do not merge `body`, `query`, or `params` into objects via `Object.assign` or spread — validate fields explicitly.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (isObjectAssignWithRequestFields(node)) {
          context.report({ node, messageId: "prototypePollutingMerge" });
        }
      },
      ObjectExpression(node: TSESTree.ObjectExpression) {
        if (objectHasRequestFieldSpread(node)) {
          context.report({ node, messageId: "prototypePollutingMerge" });
        }
      },
    };
  },
});
