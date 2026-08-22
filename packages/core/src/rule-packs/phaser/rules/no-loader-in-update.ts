import { AST_NODE_TYPES } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  analyzePhaserImports,
  createHotPathTracker,
  hotPathVisitors,
  isLoaderCall,
  memberChain,
} from "../utils";

export const RULE_NAME = "no-loader-in-update";

type MessageIds = "loaderInUpdate";

export const noLoaderInUpdateRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Do not call the Phaser Loader from update/tick/preUpdate. Queue assets in preload or a declared runtime-load path.",
    },
    schema: [],
    messages: {
      loaderInUpdate:
        "Do not call `load.*` inside `update`/`tick`/`preUpdate`. Queue assets in `preload()` or a one-shot load path.",
    },
  },
  defaultOptions: [],
  create(context) {
    let imports = analyzePhaserImports(context.sourceCode.ast);
    const hot = createHotPathTracker();

    return {
      Program(program) {
        imports = analyzePhaserImports(program);
      },
      ...hotPathVisitors(hot),
      CallExpression(node) {
        if (!imports.hasPhaserImport || !hot.isInHotPath()) {
          return;
        }

        if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        if (!isLoaderCall(memberChain(node.callee))) {
          return;
        }

        context.report({ node, messageId: "loaderInUpdate" });
      },
    };
  },
});
