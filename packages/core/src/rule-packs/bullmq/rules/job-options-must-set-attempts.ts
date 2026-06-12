import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

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

export const RULE_NAME = "job-options-must-set-attempts";

export interface JobOptionsMustSetAttemptsOptions {
  readonly requireBackoff?: boolean;
}

type RuleOptions = [JobOptionsMustSetAttemptsOptions];
type MessageIds = "missingAttempts" | "missingBackoff";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    requireBackoff: { type: "boolean" },
  },
};

export const jobOptionsMustSetAttemptsRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Every `<queue>.add(...)` must configure `attempts` (per-call or via `defaultJobOptions`); when `attempts > 1`, also require `backoff`.",
    },
    schema: [optionSchema],
    messages: {
      missingAttempts:
        "Job has no `attempts` configuration — failed jobs will not retry. Set `attempts` per-call or via `defaultJobOptions` on the Queue.",
      missingBackoff:
        "Job has `attempts > 1` but no `backoff` configuration — retries will fire back-to-back without delay, likely re-failing for the same reason. Add a `backoff` (e.g., `{ type: 'exponential', delay: 1000 }`).",
    },
  },
  defaultOptions: [{ requireBackoff: true }],
  create(context, [options]) {
    const requireBackoff = options.requireBackoff !== false;

    let imports: BullmqImports = {
      hasBullmqImport: false,
      workerLocalNames: new Set(),
      queueLocalNames: new Set(),
      queueEventsLocalNames: new Set(),
    };
    let knownQueues = new Map<string, QueueDefinition>();

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

        const attemptsValue = getEffectiveOptionValue(
          node,
          knownQueues,
          "attempts"
        );

        if (!attemptsValue) {
          context.report({ node, messageId: "missingAttempts" });

          return;
        }

        if (!requireBackoff) {
          return;
        }

        if (isAttemptsLiteralOne(attemptsValue)) {
          return;
        }

        const backoffValue = getEffectiveOptionValue(
          node,
          knownQueues,
          "backoff"
        );

        if (!backoffValue) {
          context.report({ node, messageId: "missingBackoff" });
        }
      },
    };
  },
});

function getEffectiveOptionValue(
  call: TSESTree.CallExpression,
  knownQueues: ReadonlyMap<string, QueueDefinition>,
  name: string
): TSESTree.Property["value"] | null {
  const opts = getOptionsObjectArg(call, 2);

  if (opts) {
    const property = findObjectProperty(opts, name);

    if (property) {
      return property.value;
    }
  }

  const key = getCallReceiverKey(call);

  if (!key) {
    return null;
  }

  const def = knownQueues.get(key);

  if (!def?.defaultJobOptions) {
    return null;
  }

  const defaultProperty = findObjectProperty(def.defaultJobOptions, name);

  if (!defaultProperty) {
    return null;
  }

  return defaultProperty.value;
}

function isAttemptsLiteralOne(value: TSESTree.Property["value"]): boolean {
  return (
    value.type === AST_NODE_TYPES.Literal &&
    typeof value.value === "number" &&
    value.value === 1
  );
}

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
