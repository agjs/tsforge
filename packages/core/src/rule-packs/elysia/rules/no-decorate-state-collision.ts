import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  collectElysiaVariables,
  getChainRoot,
  getMemberMethodName,
  isNewElysiaExpression,
} from "../utils/elysiaChain";

export const RULE_NAME = "no-decorate-state-collision";

export interface NoDecorateStateCollisionOptions {
  readonly methods?: readonly string[];
}

type RuleOptions = [NoDecorateStateCollisionOptions];
type MessageIds = "decorateKeyCollision";

const DEFAULT_METHODS = ["decorate", "state", "derive", "resolve"] as const;

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    methods: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
  },
};

export const noDecorateStateCollisionRule = createRule<RuleOptions, MessageIds>(
  {
    name: RULE_NAME,
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow duplicate keys across `.decorate()` / `.state()` / `.derive()` / `.resolve()` calls on a single Elysia instance — duplicates silently overwrite and break plugin composition.",
      },
      schema: [optionSchema],
      messages: {
        decorateKeyCollision:
          "Key '{{key}}' is registered more than once on this Elysia instance (previously by `.{{previous}}(...)`). Duplicate decorate/state keys silently overwrite each other and break plugin composition.",
      },
    },
    defaultOptions: [{ methods: [...DEFAULT_METHODS] }],
    create(context, [options]) {
      const methods = new Set(options.methods ?? DEFAULT_METHODS);

      let elysiaVars = new Set<string>();

      interface Registration {
        readonly key: string;
        readonly method: string;
        readonly node: TSESTree.Node;
        readonly line: number;
      }
      const registrationsByOwner = new Map<string, Registration[]>();
      const processedChains = new WeakSet();

      function ownerKey(rootCall: TSESTree.CallExpression): string {
        const root = getChainRoot(rootCall);

        if (isNewElysiaExpression(root)) {
          return `chain@${root.range[0]}`;
        }

        if (root.type === AST_NODE_TYPES.Identifier) {
          return `var:${root.name}`;
        }

        return `chain@${rootCall.range[0]}`;
      }

      function checkChain(rootCall: TSESTree.CallExpression): void {
        if (processedChains.has(rootCall)) {
          return;
        }

        processedChains.add(rootCall);

        const ordered = collectChainCalls(rootCall);
        const owner = ownerKey(rootCall);
        const existing = registrationsByOwner.get(owner) ?? [];

        for (const call of ordered) {
          if (!methods.has(call.method)) {
            continue;
          }

          for (const reg of extractRegistrations(call.node, call.method)) {
            const prior = existing.find((e) => e.key === reg.key);

            if (prior) {
              context.report({
                node: reg.node,
                messageId: "decorateKeyCollision",
                data: {
                  key: reg.key,
                  previous: prior.method,
                },
              });
            }

            existing.push(reg);
          }
        }

        registrationsByOwner.set(owner, existing);
      }

      return {
        Program(program) {
          elysiaVars = collectElysiaVariables(program);
        },
        CallExpression(node) {
          if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
            return;
          }

          const root = getChainRoot(node);

          const isElysiaChain =
            isNewElysiaExpression(root) ||
            (root.type === AST_NODE_TYPES.Identifier &&
              elysiaVars.has(root.name));

          if (!isElysiaChain) {
            return;
          }

          if (
            node.parent?.type === AST_NODE_TYPES.MemberExpression &&
            node.parent.parent?.type === AST_NODE_TYPES.CallExpression
          ) {
            return;
          }

          checkChain(node);
        },
      };
    },
  }
);

interface OrderedCall {
  readonly method: string;
  readonly node: TSESTree.CallExpression;
}

function collectChainCalls(outermost: TSESTree.CallExpression): OrderedCall[] {
  const calls: OrderedCall[] = [];
  let current: TSESTree.Expression = outermost;

  while (
    current.type === AST_NODE_TYPES.CallExpression &&
    current.callee.type === AST_NODE_TYPES.MemberExpression
  ) {
    const method = getMemberMethodName(current);

    if (method) {
      calls.push({ method, node: current });
    }

    current = current.callee.object;
  }

  return calls.reverse();
}

interface RegistrationCandidate {
  readonly key: string;
  readonly method: string;
  readonly node: TSESTree.Node;
  readonly line: number;
}

function extractRegistrations(
  call: TSESTree.CallExpression,
  method: string
): RegistrationCandidate[] {
  const arg = call.arguments[0];

  if (!arg) {
    return [];
  }

  if (arg.type === AST_NODE_TYPES.Literal && typeof arg.value === "string") {
    return [
      {
        key: arg.value,
        method,
        node: arg,
        line: arg.loc.start.line,
      },
    ];
  }

  if (arg.type === AST_NODE_TYPES.ObjectExpression) {
    return objectExpressionKeys(arg, method);
  }

  if (
    arg.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    arg.type === AST_NODE_TYPES.FunctionExpression
  ) {
    const returned = getReturnedObjectExpression(arg);

    if (returned) {
      return objectExpressionKeys(returned, method);
    }
  }

  return [];
}

function objectExpressionKeys(
  obj: TSESTree.ObjectExpression,
  method: string
): RegistrationCandidate[] {
  const out: RegistrationCandidate[] = [];

  for (const property of obj.properties) {
    if (property.type !== AST_NODE_TYPES.Property) {
      continue;
    }

    let keyName: string | null = null;

    if (property.key.type === AST_NODE_TYPES.Identifier && !property.computed) {
      keyName = property.key.name;
    } else if (
      property.key.type === AST_NODE_TYPES.Literal &&
      typeof property.key.value === "string"
    ) {
      keyName = property.key.value;
    }

    if (keyName !== null) {
      out.push({
        key: keyName,
        method,
        node: property,
        line: property.loc.start.line,
      });
    }
  }

  return out;
}

function getReturnedObjectExpression(
  fn: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression
): TSESTree.ObjectExpression | null {
  if (fn.body.type === AST_NODE_TYPES.ObjectExpression) {
    return fn.body;
  }

  if (fn.body.type === AST_NODE_TYPES.BlockStatement) {
    for (const stmt of fn.body.body) {
      if (
        stmt.type === AST_NODE_TYPES.ReturnStatement &&
        stmt.argument?.type === AST_NODE_TYPES.ObjectExpression
      ) {
        return stmt.argument;
      }
    }
  }

  return null;
}
