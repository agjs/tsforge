import { AST_NODE_TYPES } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  analyzeThreeImports,
  isLoaderCtor,
  memberPropertyName,
  receiverKey,
  resolveBindingKeys,
} from "../utils";

export const RULE_NAME = "prefer-three-load-async";

type MessageIds = "preferLoadAsync";

export const preferThreeLoadAsyncRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer `loader.loadAsync()` over the callback `load()` API so failures compose with typed Promises and `no-floating-promises`.",
    },
    schema: [],
    messages: {
      preferLoadAsync:
        "Use `{{receiver}}.loadAsync(...)` instead of callback `load()`. Callback conversion is not auto-fixed because it can change the enclosing function to async.",
    },
  },
  defaultOptions: [],
  create(context) {
    let imports = analyzeThreeImports(context.sourceCode.ast);
    const program = context.sourceCode.ast;

    return {
      Program(node) {
        imports = analyzeThreeImports(node);
      },
      CallExpression(node) {
        if (!imports.hasThreeImport) {
          return;
        }

        if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        if (memberPropertyName(node.callee) !== "load") {
          return;
        }

        if (node.arguments.length < 2) {
          return;
        }

        const receiver = receiverKey(node.callee.object);

        if (receiver === null) {
          return;
        }

        const loaders = resolveBindingKeys(
          node,
          program,
          imports,
          isLoaderCtor
        );

        if (!loaders.has(receiver)) {
          return;
        }

        context.report({
          node,
          messageId: "preferLoadAsync",
          data: { receiver },
        });
      },
    };
  },
});
