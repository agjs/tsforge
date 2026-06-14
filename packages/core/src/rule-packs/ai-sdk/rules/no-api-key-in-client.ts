import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-api-key-in-client";

type MessageIds = "clientProvider";

// Providers whose constructor / factory takes an API key. Building one in a
// `"use client"` file ships the key into the browser bundle.
const PROVIDER_CONSTRUCTORS = new Set([
  "OpenAI",
  "Anthropic",
  "GoogleGenerativeAI",
]);
const PROVIDER_FACTORIES = new Set([
  "createOpenAI",
  "createAnthropic",
  "createGoogleGenerativeAI",
  "createAzure",
  "createMistral",
]);

/** True when the file opens with a `"use client"` directive (client component). */
function hasUseClientDirective(
  body: readonly TSESTree.ProgramStatement[]
): boolean {
  for (const stmt of body) {
    if (stmt.type !== AST_NODE_TYPES.ExpressionStatement) {
      return false; // directives must lead; first non-expression ends the prologue
    }

    const expr = stmt.expression;

    if (expr.type === AST_NODE_TYPES.Literal && expr.value === "use client") {
      return true;
    }
  }

  return false;
}

/** `new OpenAI(...)` etc. */
function isProviderConstruction(node: TSESTree.NewExpression): boolean {
  return (
    node.callee.type === AST_NODE_TYPES.Identifier &&
    PROVIDER_CONSTRUCTORS.has(node.callee.name)
  );
}

/** `createOpenAI(...)` etc. */
function isProviderFactory(node: TSESTree.CallExpression): boolean {
  return (
    node.callee.type === AST_NODE_TYPES.Identifier &&
    PROVIDER_FACTORIES.has(node.callee.name)
  );
}

export const noApiKeyInClientRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow constructing an AI provider client in a client component — it leaks the API key into the browser bundle. Call the model from a server route/action.",
    },
    schema: [],
    messages: {
      clientProvider:
        "Do not create an AI provider client in a `'use client'` file — the API key would ship to the browser. Move the call to a server route or server action.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!hasUseClientDirective(context.sourceCode.ast.body)) {
      return {};
    }

    return {
      NewExpression(node: TSESTree.NewExpression) {
        if (isProviderConstruction(node)) {
          context.report({ node, messageId: "clientProvider" });
        }
      },
      CallExpression(node: TSESTree.CallExpression) {
        if (isProviderFactory(node)) {
          context.report({ node, messageId: "clientProvider" });
        }
      },
    };
  },
});
