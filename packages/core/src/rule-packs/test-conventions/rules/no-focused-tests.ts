import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-focused-tests";

export interface NoFocusedTestsOptions {
  readonly testGlobals?: readonly string[];
  readonly focusedAliases?: readonly string[];
}

type RuleOptions = [NoFocusedTestsOptions];
type MessageIds = "focusedTest";

const DEFAULT_TEST_GLOBALS: readonly string[] = [
  "test",
  "it",
  "describe",
  "suite",
];

const DEFAULT_FOCUSED_ALIASES: readonly string[] = [
  "fdescribe",
  "fit",
  "fcontext",
];

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    testGlobals: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
    focusedAliases: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
  },
};

function getMemberPropertyName(
  member: TSESTree.MemberExpression
): string | null {
  if (!member.computed && member.property.type === AST_NODE_TYPES.Identifier) {
    return member.property.name;
  }

  if (
    member.computed &&
    member.property.type === AST_NODE_TYPES.Literal &&
    typeof member.property.value === "string"
  ) {
    return member.property.value;
  }

  return null;
}

function getRootIdentifierName(node: TSESTree.Node): string | null {
  let current: TSESTree.Node = node;

  while (current.type === AST_NODE_TYPES.MemberExpression) {
    current = current.object;
  }

  if (current.type === AST_NODE_TYPES.Identifier) {
    return current.name;
  }

  return null;
}

/**
 * Returns true when any segment in the chain of MemberExpression
 * properties is `only`. Catches `test.only`, `test.skip.only`,
 * `describe.each.only`, etc., as well as the computed-key form
 * `test["only"]`.
 */
function chainHasOnly(node: TSESTree.Node): boolean {
  let current: TSESTree.Node = node;

  while (current.type === AST_NODE_TYPES.MemberExpression) {
    const name = getMemberPropertyName(current);

    if (name === "only") {
      return true;
    }

    current = current.object;
  }

  return false;
}

export const noFocusedTestsRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow focused tests (`test.only`, `it.only`, `fdescribe`, ...) — the canonical 'I forgot to remove this before committing' leak.",
    },
    schema: [optionSchema],
    messages: {
      focusedTest:
        "Focused test '{{name}}' left in source — this skips every other test in CI. Remove the `.only` / `f`-prefix before committing.",
    },
  },
  defaultOptions: [
    {
      testGlobals: [...DEFAULT_TEST_GLOBALS],
      focusedAliases: [...DEFAULT_FOCUSED_ALIASES],
    },
  ],
  create(context, [options]) {
    const testGlobals = new Set(options.testGlobals ?? DEFAULT_TEST_GLOBALS);
    const focusedAliases = new Set(
      options.focusedAliases ?? DEFAULT_FOCUSED_ALIASES
    );

    return {
      CallExpression(node) {
        const callee = node.callee;

        // Bare `fdescribe(...)` / `fit(...)`.
        if (
          callee.type === AST_NODE_TYPES.Identifier &&
          focusedAliases.has(callee.name)
        ) {
          context.report({
            node: callee,
            messageId: "focusedTest",
            data: { name: callee.name },
          });

          return;
        }

        // `test.only(...)`, `test.skip.only(...)`, `test["only"](...)`.
        if (callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        const root = getRootIdentifierName(callee);

        if (root === null || !testGlobals.has(root)) {
          return;
        }

        if (!chainHasOnly(callee)) {
          return;
        }

        const sourceText = context.sourceCode.getText(callee);

        context.report({
          node: callee,
          messageId: "focusedTest",
          data: { name: sourceText },
        });
      },
    };
  },
});
