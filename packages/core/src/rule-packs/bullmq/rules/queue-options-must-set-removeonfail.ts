import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";
import type { TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  analyzeBullmqImports,
  collectQueueDefinitions,
  findObjectProperty,
  getCallReceiverKey,
  getOptionsObjectArg,
  isQueueAddCall,
  isQueueLikeReceiverName,
  type BullmqImports,
  type QueueDefinition,
} from "../utils";

export const RULE_NAME = "queue-options-must-set-removeonfail";

export interface QueueOptionsMustSetRemoveOnFailOptions {}

type RuleOptions = [QueueOptionsMustSetRemoveOnFailOptions];
type MessageIds = "missingRemoveOnFail";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

export const queueOptionsMustSetRemoveOnFailRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Every `<queue>.add(...)` must configure `removeOnFail` (per-call or via `defaultJobOptions`) so failed jobs don't accumulate in Redis.",
    },
    schema: [optionSchema],
    messages: {
      missingRemoveOnFail:
        "Job has no `removeOnFail` configuration — failed jobs accumulate in Redis indefinitely. Set it per-call or via `defaultJobOptions` on the Queue.",
    },
  },
  defaultOptions: [{}],
  create(context) {
    let imports: BullmqImports = {
      hasBullmqImport: false,
      workerLocalNames: new Set(),
      queueLocalNames: new Set(),
      queueEventsLocalNames: new Set(),
    };
    let knownQueues: Map<string, QueueDefinition> = new Map();

    return {
      Program(program) {
        imports = analyzeBullmqImports(program);
        knownQueues = collectQueueDefinitions(program, imports);
      },
      CallExpression(node) {
        if (!isQueueAddCall(node)) {
          return;
        }

        if (!receiverIsQueueLike(node, knownQueues)) {
          return;
        }

        if (callHasOption(node, "removeOnFail")) {
          return;
        }

        if (queueDefaultsHaveOption(node, knownQueues, "removeOnFail")) {
          return;
        }

        context.report({ node, messageId: "missingRemoveOnFail" });
      },
    };
  },
});

function receiverIsQueueLike(
  call: TSESTree.CallExpression,
  knownQueues: ReadonlyMap<string, QueueDefinition>
): boolean {
  const key = getCallReceiverKey(call);

  if (!key) {
    return false;
  }

  if (knownQueues.has(key)) {
    return true;
  }

  const last = key.includes(".") ? (key.split(".").pop() ?? key) : key;

  return isQueueLikeReceiverName(last);
}

function callHasOption(call: TSESTree.CallExpression, name: string): boolean {
  const opts = getOptionsObjectArg(call, 2);

  if (!opts) {
    return false;
  }

  return findObjectProperty(opts, name) !== null;
}

function queueDefaultsHaveOption(
  call: TSESTree.CallExpression,
  knownQueues: ReadonlyMap<string, QueueDefinition>,
  name: string
): boolean {
  const key = getCallReceiverKey(call);

  if (!key) {
    return false;
  }

  const def = knownQueues.get(key);

  if (!def?.defaultJobOptions) {
    return false;
  }

  return findObjectProperty(def.defaultJobOptions, name) !== null;
}
