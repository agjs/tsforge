import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";

export const RULE_NAME = "bcrypt-rounds-min";

export interface BcryptRoundsMinOptions {
  readonly minRounds?: number;
  readonly bcryptModules?: readonly string[];
}

type RuleOptions = [BcryptRoundsMinOptions];
type MessageIds = "roundsTooLow";

const DEFAULT_MIN_ROUNDS = 10;
const DEFAULT_BCRYPT_MODULES: readonly string[] = ["bcrypt", "bcryptjs"];

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    minRounds: { type: "number", minimum: 1 },
    bcryptModules: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
  },
};

interface ImportTracker {
  readonly bindings: Map<string, string>; // local name -> module
}

export const bcryptRoundsMinRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `bcrypt.hash` / `bcrypt.hashSync` calls with a numeric-literal rounds value below the configured minimum (default 10).",
    },
    schema: [optionSchema],
    messages: {
      roundsTooLow:
        "{{module}}.{{method}} with {{found}} rounds is below the {{min}} minimum — too cheap to bruteforce in 2026.",
    },
  },
  defaultOptions: [
    {
      minRounds: DEFAULT_MIN_ROUNDS,
      bcryptModules: [...DEFAULT_BCRYPT_MODULES],
    },
  ],
  create(context, [options]) {
    const minRounds = options.minRounds ?? DEFAULT_MIN_ROUNDS;
    const bcryptModules = new Set(
      options.bcryptModules ?? DEFAULT_BCRYPT_MODULES
    );

    const tracker: ImportTracker = { bindings: new Map() };

    function getRootIdentifier(
      node: TSESTree.Node
    ): TSESTree.Identifier | null {
      let current: TSESTree.Node = node;

      while (current.type === AST_NODE_TYPES.MemberExpression) {
        current = current.object;
      }

      if (current.type === AST_NODE_TYPES.Identifier) {
        return current;
      }

      return null;
    }

    function getMemberMethodName(
      callee: TSESTree.MemberExpression
    ): string | null {
      if (
        callee.computed ||
        callee.property.type !== AST_NODE_TYPES.Identifier
      ) {
        return null;
      }

      return callee.property.name;
    }

    return {
      ImportDeclaration(node) {
        const source = node.source.value;

        if (!bcryptModules.has(source)) {
          return;
        }

        for (const spec of node.specifiers) {
          if (
            spec.type === AST_NODE_TYPES.ImportDefaultSpecifier ||
            spec.type === AST_NODE_TYPES.ImportNamespaceSpecifier
          ) {
            tracker.bindings.set(spec.local.name, source);
          } else if (spec.type === AST_NODE_TYPES.ImportSpecifier) {
            // `import { hash } from "bcrypt"` — local name resolves directly.
            tracker.bindings.set(spec.local.name, source);
          }
        }
      },
      CallExpression(node) {
        const callee = node.callee;

        // Member style: `bcrypt.hash(...)`, `bcrypt.hashSync(...)`.
        if (callee.type === AST_NODE_TYPES.MemberExpression) {
          const root = getRootIdentifier(callee);

          if (root === null) {
            return;
          }

          const moduleName = tracker.bindings.get(root.name);

          if (moduleName === undefined) {
            return;
          }

          const method = getMemberMethodName(callee);

          if (method !== "hash" && method !== "hashSync") {
            return;
          }

          checkRoundsArg(node, moduleName, method);

          return;
        }

        // Direct call style: `import { hash } from "bcrypt"; hash(plain, 8);`
        if (callee.type === AST_NODE_TYPES.Identifier) {
          const moduleName = tracker.bindings.get(callee.name);

          if (moduleName === undefined) {
            return;
          }

          if (callee.name !== "hash" && callee.name !== "hashSync") {
            return;
          }

          checkRoundsArg(node, moduleName, callee.name);
        }
      },
    };

    function checkRoundsArg(
      node: TSESTree.CallExpression,
      moduleName: string,
      method: string
    ): void {
      const arg = node.arguments[1];

      if (arg === undefined) {
        return;
      }

      // Identifier or any non-literal: assumed env-driven, accepted.
      if (arg.type !== AST_NODE_TYPES.Literal) {
        return;
      }

      if (typeof arg.value !== "number") {
        return;
      }

      if (arg.value >= minRounds) {
        return;
      }

      context.report({
        node: arg,
        messageId: "roundsTooLow",
        data: {
          module: moduleName,
          method,
          found: String(arg.value),
          min: String(minRounds),
        },
      });
    }
  },
});
