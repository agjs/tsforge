import { AST_NODE_TYPES } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  analyzeThreeImports,
  isLoaderCtor,
  memberPropertyName,
  receiverKey,
  resolveBindingKeys,
} from "../utils";

export const RULE_NAME = "require-three-loader-error-path";

type MessageIds = "missingLoaderError";

export const requireThreeLoaderErrorPathRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "A Three.js loader `.load(url, onLoad)` call must pass an `onError` callback (4th argument), or prefer `loadAsync()` and handle the rejection.",
    },
    schema: [],
    messages: {
      missingLoaderError:
        "`{{receiver}}.load()` is missing an `onError` callback. Pass the 4th argument or switch to `loadAsync()` so load failures are not silent.",
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

        if (node.arguments.length < 2 || node.arguments.length >= 4) {
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
          messageId: "missingLoaderError",
          data: { receiver },
        });
      },
    };
  },
});
