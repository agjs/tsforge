import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-vacuous-expect";

type MessageIds = "typeofExpect" | "tautologyExpect" | "soleWeakExpect";

const WEAK_MATCHERS = new Set([
  "toBeDefined",
  "toBeTruthy",
  "toBeFalsy",
  "toBeUndefined",
]);

const TYPEOF_STRINGS = new Set([
  "undefined",
  "object",
  "boolean",
  "number",
  "bigint",
  "string",
  "symbol",
  "function",
]);

const TEST_CALLEES = new Set(["it", "test"]);

interface ITestFrame {
  readonly node: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;
  expectCount: number;
  weakSoleCandidate: TSESTree.CallExpression | null;
}

function isExpectCall(node: TSESTree.CallExpression): boolean {
  return (
    node.callee.type === AST_NODE_TYPES.Identifier &&
    node.callee.name === "expect"
  );
}

/** Unwrap matcher call to the `expect(...)` root, or null. */
function expectRootCall(
  node: TSESTree.CallExpression
): TSESTree.CallExpression | null {
  let current: TSESTree.Node = node.callee;

  while (current.type === AST_NODE_TYPES.MemberExpression) {
    current = current.object;
  }

  if (current.type === AST_NODE_TYPES.CallExpression && isExpectCall(current)) {
    return current;
  }

  return null;
}

function matcherName(node: TSESTree.CallExpression): string | null {
  const callee = node.callee;

  if (
    callee.type !== AST_NODE_TYPES.MemberExpression ||
    callee.computed ||
    callee.property.type !== AST_NODE_TYPES.Identifier
  ) {
    return null;
  }

  return callee.property.name;
}

function isTypeofArg(arg: TSESTree.Node | undefined): boolean {
  return (
    arg?.type === AST_NODE_TYPES.UnaryExpression && arg.operator === "typeof"
  );
}

function isTypeofStringLiteral(arg: TSESTree.Node | undefined): boolean {
  return (
    arg?.type === AST_NODE_TYPES.Literal &&
    typeof arg.value === "string" &&
    TYPEOF_STRINGS.has(arg.value)
  );
}

function isBooleanLiteral(
  arg: TSESTree.Node | undefined,
  value: boolean
): boolean {
  return arg?.type === AST_NODE_TYPES.Literal && arg.value === value;
}

function isTestCallback(
  node: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression
): boolean {
  const parent = node.parent;

  if (parent?.type !== AST_NODE_TYPES.CallExpression) {
    return false;
  }

  const callee = parent.callee;

  return (
    callee.type === AST_NODE_TYPES.Identifier &&
    TEST_CALLEES.has(callee.name) &&
    parent.arguments.length >= 2 &&
    parent.arguments[1] === node
  );
}

export const noVacuousExpectRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow vacuous expects (typeof checks, tautologies, sole toBeDefined/toBeTruthy) — tests must assert behavior.",
    },
    schema: [],
    messages: {
      typeofExpect:
        "Do not assert `typeof` — that only proves a binding exists. Assert a domain result, throw, or observable effect.",
      tautologyExpect:
        "Do not assert a boolean tautology (`expect(true).toBe(true)`). Assert something that can fail for a real regression.",
      soleWeakExpect:
        "A sole `{{matcher}}` does not lock behavior — add an assertion on the value/outcome, or replace this test.",
    },
  },
  defaultOptions: [],
  create(context) {
    const stack: ITestFrame[] = [];

    const enterFn = (
      node: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression
    ): void => {
      if (isTestCallback(node)) {
        stack.push({ node, expectCount: 0, weakSoleCandidate: null });
      }
    };

    const exitFn = (
      node: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression
    ): void => {
      const top = stack[stack.length - 1];

      if (top?.node !== node) {
        return;
      }

      stack.pop();

      if (top.expectCount === 1 && top.weakSoleCandidate !== null) {
        const matcher = matcherName(top.weakSoleCandidate);

        if (matcher !== null) {
          context.report({
            node: top.weakSoleCandidate,
            messageId: "soleWeakExpect",
            data: { matcher },
          });
        }
      }
    };

    return {
      ArrowFunctionExpression: enterFn,
      FunctionExpression: enterFn,
      "ArrowFunctionExpression:exit": exitFn,
      "FunctionExpression:exit": exitFn,
      CallExpression(node) {
        const root = expectRootCall(node);

        if (root === null || root === node) {
          return;
        }

        const matcher = matcherName(node);

        if (matcher === null) {
          return;
        }

        const frame = stack[stack.length - 1];

        if (frame !== undefined) {
          frame.expectCount += 1;
        }

        const expectArg = root.arguments[0];
        const matcherArg = node.arguments[0];

        if (matcher === "toBe" || matcher === "toEqual") {
          if (isTypeofArg(expectArg) && isTypeofStringLiteral(matcherArg)) {
            context.report({ node, messageId: "typeofExpect" });

            return;
          }

          if (
            (isBooleanLiteral(expectArg, true) &&
              isBooleanLiteral(matcherArg, true)) ||
            (isBooleanLiteral(expectArg, false) &&
              isBooleanLiteral(matcherArg, false))
          ) {
            context.report({ node, messageId: "tautologyExpect" });

            return;
          }
        }

        if (WEAK_MATCHERS.has(matcher) && frame !== undefined) {
          frame.weakSoleCandidate = node;
        } else if (frame !== undefined) {
          frame.weakSoleCandidate = null;
        }
      },
    };
  },
});
