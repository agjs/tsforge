import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-template-trim-empty-ternary";

type MessageIds = "extractToUtil";

/**
 * Bans the "build a string from a template literal, trim it, ternary
 * against empty" pattern:
 *
 *   `${first} ${last}`.trim() === "" ? email : `${first} ${last}`.trim()
 *
 * Patterns like this are testability traps: the same expression is
 * built twice in the call site, no name documents the intent, and tests
 * have to duplicate the construction to verify behaviour. Extract to a
 * named util (e.g. `buildDisplayName({ first, last, fallback }))`) and
 * test it in one place.
 */
export const noTemplateTrimEmptyTernaryRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow inline `<template>.trim() === '' ? fallback : <template>.trim()` patterns. Extract to a named utility.",
    },
    schema: [],
    messages: {
      extractToUtil:
        "Extract this `<template>.trim() === ''` fallback pattern to a named util (e.g. `buildDisplayName(...)`). Inline ternaries duplicate the expression and aren't unit-testable in one place.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ConditionalExpression(node) {
        if (matchesTemplateTrimEmptyTest(node.test)) {
          context.report({ node, messageId: "extractToUtil" });
        }
      },
    };
  },
});

function matchesTemplateTrimEmptyTest(test: TSESTree.Expression): boolean {
  if (test.type !== AST_NODE_TYPES.BinaryExpression) {
    return false;
  }

  if (test.operator !== "===" && test.operator !== "!==") {
    return false;
  }

  return (
    (isTrimCallOnTemplate(test.left) && isEmptyStringLiteral(test.right)) ||
    (isEmptyStringLiteral(test.left) && isTrimCallOnTemplate(test.right))
  );
}

function isTrimCallOnTemplate(node: TSESTree.Node): boolean {
  if (node.type !== AST_NODE_TYPES.CallExpression) {
    return false;
  }

  if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
    return false;
  }

  if (
    node.callee.property.type !== AST_NODE_TYPES.Identifier ||
    node.callee.property.name !== "trim"
  ) {
    return false;
  }

  return node.callee.object.type === AST_NODE_TYPES.TemplateLiteral;
}

function isEmptyStringLiteral(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.Literal &&
    typeof node.value === "string" &&
    node.value === ""
  );
}
