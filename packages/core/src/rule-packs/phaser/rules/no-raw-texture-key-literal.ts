import { AST_NODE_TYPES } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  analyzePhaserImports,
  isTextureKeyCall,
  memberChain,
  stringLiteralValue,
} from "../utils";

export const RULE_NAME = "no-raw-texture-key-literal";

type MessageIds = "rawTextureKey";

export const noRawTextureKeyLiteralRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Pass texture and audio keys as named constants, not string literals, to load/add/textures/sound APIs.",
    },
    schema: [],
    messages: {
      rawTextureKey:
        "Do not pass a string literal as a texture/audio key. Use a named key constant.",
    },
  },
  defaultOptions: [],
  create(context) {
    let imports = analyzePhaserImports(context.sourceCode.ast);

    return {
      Program(program) {
        imports = analyzePhaserImports(program);
      },
      CallExpression(node) {
        if (!imports.hasPhaserImport) {
          return;
        }

        if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        const keyArg = isTextureKeyCall(
          memberChain(node.callee),
          node.arguments
        );

        if (keyArg === null || stringLiteralValue(keyArg) === null) {
          return;
        }

        context.report({ node: keyArg, messageId: "rawTextureKey" });
      },
    };
  },
});
