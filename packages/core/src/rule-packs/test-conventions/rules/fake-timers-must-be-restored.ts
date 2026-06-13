import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { walkAll } from "../../utils";

export const RULE_NAME = "fake-timers-must-be-restored";

export interface IFakeTimersMustBeRestoredOptions {
  readonly fakeTimerMethods?: readonly string[];
  readonly restoreTimerMethods?: readonly string[];
}

type RuleOptions = [IFakeTimersMustBeRestoredOptions];
type MessageIds = "timersNotRestored";

const DEFAULT_FAKE_TIMER_METHODS = ["useFakeTimers"] as const;
const DEFAULT_RESTORE_TIMER_METHODS = ["useRealTimers"] as const;

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    fakeTimerMethods: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
    restoreTimerMethods: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
  },
};

function getMemberPropertyName(
  member: TSESTree.MemberExpression
): string | null {
  if (!member.computed && member.property.type === AST_NODE_TYPES.Identifier) {
    return member.property.name;
  }

  return null;
}

function callUsesMethod(
  node: TSESTree.CallExpression,
  methods: ReadonlySet<string>
): boolean {
  const callee = node.callee;

  if (callee.type === AST_NODE_TYPES.Identifier) {
    return methods.has(callee.name);
  }

  if (callee.type === AST_NODE_TYPES.MemberExpression) {
    const name = getMemberPropertyName(callee);

    return name !== null && methods.has(name);
  }

  return false;
}

export const fakeTimersMustBeRestoredRule = createRule<RuleOptions, MessageIds>(
  {
    name: RULE_NAME,
    meta: {
      type: "problem",
      docs: {
        description:
          "When a test file calls `useFakeTimers()`, it must also call `useRealTimers()` so later tests are not affected.",
      },
      schema: [optionSchema],
      messages: {
        timersNotRestored:
          "`{{method}}()` was called without a matching restore call — fake timers leak into other tests.",
      },
    },
    defaultOptions: [
      {
        fakeTimerMethods: [...DEFAULT_FAKE_TIMER_METHODS],
        restoreTimerMethods: [...DEFAULT_RESTORE_TIMER_METHODS],
      },
    ],
    create(context, [options]) {
      const fakeMethods = new Set(
        options.fakeTimerMethods ?? DEFAULT_FAKE_TIMER_METHODS
      );
      const restoreMethods = new Set(
        options.restoreTimerMethods ?? DEFAULT_RESTORE_TIMER_METHODS
      );

      return {
        Program(node) {
          const fakeCalls: TSESTree.CallExpression[] = [];
          let hasRestore = false;

          walkAll(node, (child) => {
            if (child.type !== AST_NODE_TYPES.CallExpression) {
              return;
            }

            if (callUsesMethod(child, fakeMethods)) {
              fakeCalls.push(child);
            }

            if (callUsesMethod(child, restoreMethods)) {
              hasRestore = true;
            }
          });

          if (fakeCalls.length === 0 || hasRestore) {
            return;
          }

          for (const call of fakeCalls) {
            const callee = call.callee;
            let method = "useFakeTimers";

            if (
              callee.type === AST_NODE_TYPES.MemberExpression &&
              callee.property.type === AST_NODE_TYPES.Identifier
            ) {
              method = callee.property.name;
            } else if (callee.type === AST_NODE_TYPES.Identifier) {
              method = callee.name;
            }

            context.report({
              node: call,
              messageId: "timersNotRestored",
              data: { method },
            });
          }
        },
      };
    },
  }
);
