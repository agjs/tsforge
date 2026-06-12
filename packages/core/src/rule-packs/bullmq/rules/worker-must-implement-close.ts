import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  analyzeBullmqImports,
  isNewWorker,
  walkSome,
  type BullmqImports,
} from "../utils";

export const RULE_NAME = "worker-must-implement-close";

export interface WorkerMustImplementCloseOptions {
  readonly closeMethodNames?: readonly string[];
}

type RuleOptions = [WorkerMustImplementCloseOptions];
type MessageIds = "missingClose";

const DEFAULT_CLOSE_METHODS: readonly string[] = [
  "close",
  "shutdown",
  "dispose",
  "onModuleDestroy",
];

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    closeMethodNames: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
  },
};

export const workerMustImplementCloseRule = createRule<RuleOptions, MessageIds>(
  {
    name: RULE_NAME,
    meta: {
      type: "problem",
      docs: {
        description:
          "Classes that own a `new Worker(...)` instance must declare a close-equivalent method for graceful shutdown.",
      },
      schema: [optionSchema],
      messages: {
        missingClose:
          "Class '{{name}}' owns a `new Worker(...)` instance but does not declare a close method ({{methods}}). BullMQ workers must be explicitly closed during graceful shutdown — otherwise jobs in flight are abandoned and Redis connections leak.",
      },
    },
    defaultOptions: [{ closeMethodNames: [...DEFAULT_CLOSE_METHODS] }],
    create(context, [options]) {
      const closeMethods = new Set(
        options.closeMethodNames ?? DEFAULT_CLOSE_METHODS
      );

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
        ClassDeclaration(node) {
          if (!imports.hasBullmqImport) {
            return;
          }

          if (!classOwnsWorker(node, imports)) {
            return;
          }

          if (classDeclaresAnyMethod(node, closeMethods)) {
            return;
          }

          const className = node.id?.name ?? "<anonymous>";
          const methodList = [...closeMethods]
            .map((m) => `\`${m}\``)
            .join(", ");

          context.report({
            node: node.id ?? node,
            messageId: "missingClose",
            data: { name: className, methods: methodList },
          });
        },
      };
    },
  }
);

function classOwnsWorker(
  cls: TSESTree.ClassDeclaration,
  imports: BullmqImports
): boolean {
  for (const member of cls.body.body) {
    if (
      member.type === AST_NODE_TYPES.PropertyDefinition &&
      member.value &&
      isNewWorker(member.value, imports)
    ) {
      return true;
    }

    if (member.type === AST_NODE_TYPES.MethodDefinition) {
      const fnBody = member.value.body;

      if (!fnBody) {
        continue;
      }

      const found = walkSome(fnBody, (n) => {
        if (n.type !== AST_NODE_TYPES.AssignmentExpression) {
          return false;
        }

        if (
          n.left.type !== AST_NODE_TYPES.MemberExpression ||
          n.left.object.type !== AST_NODE_TYPES.ThisExpression
        ) {
          return false;
        }

        return isNewWorker(n.right, imports);
      });

      if (found) {
        return true;
      }
    }
  }

  return false;
}

function classDeclaresAnyMethod(
  cls: TSESTree.ClassDeclaration,
  methodNames: ReadonlySet<string>
): boolean {
  for (const member of cls.body.body) {
    if (member.type !== AST_NODE_TYPES.MethodDefinition) {
      continue;
    }

    if (member.kind === "constructor") {
      continue;
    }

    const name = getMethodName(member);

    if (name && methodNames.has(name)) {
      return true;
    }
  }

  return false;
}

function getMethodName(method: TSESTree.MethodDefinition): string | null {
  if (method.key.type === AST_NODE_TYPES.Identifier) {
    return method.key.name;
  }

  if (
    method.key.type === AST_NODE_TYPES.Literal &&
    typeof method.key.value === "string"
  ) {
    return method.key.value;
  }

  return null;
}
