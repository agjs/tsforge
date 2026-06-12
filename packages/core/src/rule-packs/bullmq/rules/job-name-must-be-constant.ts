import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  analyzeBullmqImports,
  collectQueueDefinitions,
  getCallReceiverKey,
  isQueueAddCall,
  isQueueLikeReceiverName,
  type BullmqImports,
  type QueueDefinition,
} from "../utils";

export const RULE_NAME = "job-name-must-be-constant";

export interface JobNameMustBeConstantOptions {
  readonly queueNamePattern?: string;
}

type RuleOptions = [JobNameMustBeConstantOptions];
type MessageIds = "literalJobName";

const DEFAULT_QUEUE_NAME_PATTERN = "Queue$";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    queueNamePattern: { type: "string", minLength: 1 },
  },
};

export const jobNameMustBeConstantRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow string-literal job names in `<queue>.add(name, ...)` calls — use a constant identifier so all consumers share one source of truth.",
    },
    schema: [optionSchema],
    messages: {
      literalJobName:
        "Job name `{{value}}` is an inline string literal — pass a constant identifier (e.g., `JOB_NAMES.foo`) so producers, workers, and dashboards share one source of truth.",
    },
  },
  defaultOptions: [{ queueNamePattern: DEFAULT_QUEUE_NAME_PATTERN }],
  create(context, [options]) {
    const queuePattern = compilePattern(
      options.queueNamePattern ?? DEFAULT_QUEUE_NAME_PATTERN
    );

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

        if (!receiverIsQueueLike(node, knownQueues, queuePattern)) {
          return;
        }

        const nameArg = node.arguments[0];

        if (!nameArg) {
          return;
        }

        if (
          nameArg.type === AST_NODE_TYPES.Literal &&
          typeof nameArg.value === "string"
        ) {
          context.report({
            node: nameArg,
            messageId: "literalJobName",
            data: { value: nameArg.value },
          });

          return;
        }

        if (
          nameArg.type === AST_NODE_TYPES.TemplateLiteral &&
          nameArg.expressions.length === 0 &&
          nameArg.quasis.length > 0
        ) {
          context.report({
            node: nameArg,
            messageId: "literalJobName",
            data: { value: nameArg.quasis[0]?.value.cooked ?? "" },
          });
        }
      },
    };
  },
});

function receiverIsQueueLike(
  call: TSESTree.CallExpression,
  knownQueues: ReadonlyMap<string, QueueDefinition>,
  queuePattern: RegExp | null
): boolean {
  const key = getCallReceiverKey(call);

  if (!key) {
    return false;
  }

  if (knownQueues.has(key)) {
    return true;
  }

  if (!queuePattern) {
    return false;
  }

  const last = key.includes(".") ? (key.split(".").pop() ?? key) : key;

  return queuePattern.test(last) || isQueueLikeReceiverName(last);
}

function compilePattern(source: string): RegExp | null {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}
