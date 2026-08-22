import { AST_NODE_TYPES } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  analyzeThreeImports,
  findEnclosingFunction,
  functionContainsCall,
  isCameraCtor,
  memberPropertyName,
  receiverKey,
  resolveBindingKeys,
} from "../utils";

export const RULE_NAME = "require-projection-update";

type MessageIds = "missingProjectionUpdate";

export const requireProjectionUpdateRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "After writing `camera.aspect`, call `camera.updateProjectionMatrix()` so the view frustum matches the new aspect ratio.",
    },
    fixable: "code",
    schema: [],
    messages: {
      missingProjectionUpdate:
        "Call `{{receiver}}.updateProjectionMatrix()` after assigning `aspect`, or the camera frustum will not update.",
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
      AssignmentExpression(node) {
        if (!imports.hasThreeImport) {
          return;
        }

        if (node.left.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        if (memberPropertyName(node.left) !== "aspect") {
          return;
        }

        const receiver = receiverKey(node.left.object);

        if (receiver === null) {
          return;
        }

        const cameras = resolveBindingKeys(
          node,
          program,
          imports,
          isCameraCtor
        );

        if (!cameras.has(receiver)) {
          return;
        }

        const scope = findEnclosingFunction(node) ?? program;

        if (functionContainsCall(scope, receiver, "updateProjectionMatrix")) {
          return;
        }

        context.report({
          node,
          messageId: "missingProjectionUpdate",
          data: { receiver },
          fix: (fixer) =>
            fixer.insertTextAfter(
              node,
              `; ${receiver}.updateProjectionMatrix()`
            ),
        });
      },
    };
  },
});
