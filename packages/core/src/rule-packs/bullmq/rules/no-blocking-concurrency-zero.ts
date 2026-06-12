import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  analyzeBullmqImports,
  findObjectProperty,
  getOptionsObjectArg,
  isNewWorker,
  type BullmqImports,
} from "../utils";

export const RULE_NAME = "no-blocking-concurrency-zero";

type RuleOptions = [];
type MessageIds = "invalidConcurrency";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

export const noBlockingConcurrencyZeroRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `new Worker(name, processor, { concurrency: <numericLiteral ≤ 0> })` — non-positive concurrency blocks job processing.",
    },
    schema: [optionSchema],
    messages: {
      invalidConcurrency:
        "Worker concurrency must be ≥ 1 — `{{value}}` would block job processing entirely. Use a positive integer or read from configuration.",
    },
  },
  defaultOptions: [],
  create(context) {
    let imports: BullmqImports = {
      hasBullmqImport: false,
      workerLocalNames: new Set(),
      queueLocalNames: new Set(),
      queueEventsLocalNames: new Set(),
    };

    return {
      Program(program) {
        imports = analyzeBullmqImports(program);
      },
      NewExpression(node) {
        if (!isNewWorker(node, imports)) {
          return;
        }

        const opts = getOptionsObjectArg(node, 2);

        if (!opts) {
          return;
        }

        const concurrency = findObjectProperty(opts, "concurrency");

        if (!concurrency) {
          return;
        }

        const value = concurrency.value;

        if (
          value.type === AST_NODE_TYPES.Literal &&
          typeof value.value === "number" &&
          value.value <= 0
        ) {
          context.report({
            node: value,
            messageId: "invalidConcurrency",
            data: { value: String(value.value) },
          });

          return;
        }

        if (
          value.type === AST_NODE_TYPES.UnaryExpression &&
          value.operator === "-" &&
          value.argument.type === AST_NODE_TYPES.Literal &&
          typeof value.argument.value === "number" &&
          value.argument.value > 0
        ) {
          context.report({
            node: value,
            messageId: "invalidConcurrency",
            data: { value: `-${value.argument.value}` },
          });
        }
      },
    };
  },
});
