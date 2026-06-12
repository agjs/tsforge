import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  analyzeBullmqImports,
  collectWorkerDefinitions,
  getReceiverKey,
  walkAll,
  type BullmqImports,
  type WorkerDefinition,
} from "../utils";

export const RULE_NAME = "worker-must-listen-failed";

export interface WorkerMustListenFailedOptions {
  readonly requiredEvents?: readonly string[];
}

type RuleOptions = [WorkerMustListenFailedOptions];
type MessageIds = "missingListener";

const DEFAULT_REQUIRED_EVENTS: readonly string[] = ["failed"];

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    requiredEvents: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
  },
};

export const workerMustListenFailedRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Every `new Worker(...)` must register listeners for required events (default `failed`) — BullMQ failures are silent unless explicitly subscribed.",
    },
    schema: [optionSchema],
    messages: {
      missingListener:
        "Worker assigned to `{{name}}` has no `.on('{{event}}', ...)` listener — BullMQ failures are silent unless explicitly subscribed.",
    },
  },
  defaultOptions: [{ requiredEvents: [...DEFAULT_REQUIRED_EVENTS] }],
  create(context, [options]) {
    const requiredEvents = options.requiredEvents ?? DEFAULT_REQUIRED_EVENTS;

    let imports: BullmqImports = {
      hasBullmqImport: false,
      workerLocalNames: new Set(),
      queueLocalNames: new Set(),
      queueEventsLocalNames: new Set(),
    };
    let workers: WorkerDefinition[] = [];
    let listenerKeyEventPairs: Set<string> = new Set();

    return {
      Program(program) {
        imports = analyzeBullmqImports(program);

        if (!imports.hasBullmqImport) {
          return;
        }

        workers = collectWorkerDefinitions(program, imports);
        listenerKeyEventPairs = collectOnListeners(program);
      },
      "Program:exit"() {
        if (!imports.hasBullmqImport) {
          return;
        }

        for (const worker of workers) {
          const bindingKey = worker.bindingKey;

          if (!bindingKey) {
            continue;
          }

          for (const event of requiredEvents) {
            const key = `${bindingKey}::${event}`;

            if (!listenerKeyEventPairs.has(key)) {
              context.report({
                node: worker.node,
                messageId: "missingListener",
                data: { name: bindingKey, event },
              });
            }
          }
        }
      },
    };
  },
});

function collectOnListeners(program: TSESTree.Program): Set<string> {
  const pairs = new Set<string>();

  walkAll(program, (node) => {
    if (node.type !== AST_NODE_TYPES.CallExpression) {
      return;
    }

    if (
      node.callee.type !== AST_NODE_TYPES.MemberExpression ||
      node.callee.property.type !== AST_NODE_TYPES.Identifier ||
      node.callee.property.name !== "on"
    ) {
      return;
    }

    const receiverKey = getReceiverKey(node.callee.object);

    if (!receiverKey) {
      return;
    }

    const eventArg = node.arguments[0];

    if (
      !eventArg ||
      eventArg.type !== AST_NODE_TYPES.Literal ||
      typeof eventArg.value !== "string"
    ) {
      return;
    }

    pairs.add(`${receiverKey}::${eventArg.value}`);
  });

  return pairs;
}
