import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "require-completion-token-limit";

type MessageIds = "missingLimit";

// Vercel AI SDK top-level generators.
const VERCEL_FNS = new Set([
  "generateText",
  "streamText",
  "generateObject",
  "streamObject",
]);
// Provider-SDK members that own a `.create(...)` completion call.
const CREATE_OWNERS = new Set(["completions", "messages", "responses"]);
// Any of these keys bounds the output, across SDKs.
const TOKEN_KEYS = new Set([
  "maxTokens",
  "max_tokens",
  "maxOutputTokens",
  "max_output_tokens",
  "max_completion_tokens",
]);

/** The options object literal for a Vercel generator call, or null. */
function vercelOptionsArg(
  node: TSESTree.CallExpression
): TSESTree.ObjectExpression | null {
  if (node.callee.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  if (!VERCEL_FNS.has(node.callee.name)) {
    return null;
  }

  const arg = node.arguments[0];

  return arg?.type === AST_NODE_TYPES.ObjectExpression ? arg : null;
}

/** The options object for an `x.<owner>.create({...})` SDK call, or null. */
function createCallOptionsArg(
  node: TSESTree.CallExpression
): TSESTree.ObjectExpression | null {
  const callee = node.callee;

  if (
    callee.type !== AST_NODE_TYPES.MemberExpression ||
    callee.computed ||
    callee.property.type !== AST_NODE_TYPES.Identifier ||
    callee.property.name !== "create"
  ) {
    return null;
  }

  const owner = callee.object;

  if (
    owner.type !== AST_NODE_TYPES.MemberExpression ||
    owner.computed ||
    owner.property.type !== AST_NODE_TYPES.Identifier ||
    !CREATE_OWNERS.has(owner.property.name)
  ) {
    return null;
  }

  const arg = node.arguments[0];

  return arg?.type === AST_NODE_TYPES.ObjectExpression ? arg : null;
}

/** True when the object literal sets one of the recognized token-limit keys. */
function hasTokenLimit(obj: TSESTree.ObjectExpression): boolean {
  return obj.properties.some(
    (p) =>
      p.type === AST_NODE_TYPES.Property &&
      !p.computed &&
      p.key.type === AST_NODE_TYPES.Identifier &&
      TOKEN_KEYS.has(p.key.name)
  );
}

export const requireCompletionTokenLimitRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a token limit (maxTokens / max_tokens) on AI completion calls to bound runaway cost and latency.",
    },
    schema: [],
    messages: {
      missingLimit:
        "AI completion call has no token limit — set `maxTokens` (Vercel AI SDK) or `max_tokens` (OpenAI/Anthropic) to bound cost and latency.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const options = vercelOptionsArg(node) ?? createCallOptionsArg(node);

        if (options !== null && !hasTokenLimit(options)) {
          context.report({ node, messageId: "missingLimit" });
        }
      },
    };
  },
});
