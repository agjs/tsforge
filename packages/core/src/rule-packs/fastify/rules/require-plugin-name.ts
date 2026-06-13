import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { findObjectProperty } from "../utils/fastifyChain";

export const RULE_NAME = "require-plugin-name";

type MessageIds = "missingPluginName";

function isFpCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  return callee.type === AST_NODE_TYPES.Identifier && callee.name === "fp";
}

export const requirePluginNameRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "fastify-plugin (fp) wrappers must include a `name` option so Fastify can deduplicate plugin registration.",
    },
    schema: [],
    messages: {
      missingPluginName:
        "`fp(..., { name: '...' })` must include a `name` property in the options object.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (!isFpCall(node)) {
          return;
        }

        const optionsArg = node.arguments[1];

        if (optionsArg?.type !== AST_NODE_TYPES.ObjectExpression) {
          context.report({ node, messageId: "missingPluginName" });

          return;
        }

        const nameProp = findObjectProperty(optionsArg, "name");

        if (nameProp === null) {
          context.report({ node, messageId: "missingPluginName" });
        }
      },
    };
  },
});
