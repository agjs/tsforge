import { AST_NODE_TYPES } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  analyzeThreeImports,
  isObject3DCtor,
  memberPropertyName,
  receiverKey,
  resolveBindingKeys,
} from "../utils";

export const RULE_NAME = "no-disabled-frustum-culling";

type MessageIds = "frustumCulledDisabled";

export const noDisabledFrustumCullingRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Leave `Object3D.frustumCulled` at its default (`true`) unless a custom shader invalidates geometric bounds. Disabling it is a measurable extra draw.",
    },
    schema: [],
    messages: {
      frustumCulledDisabled:
        "Avoid `{{receiver}}.frustumCulled = false` unless the object's bounds are intentionally wrong (vertex-shader displacement, custom projection). Culling is on by default.",
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

        if (memberPropertyName(node.left) !== "frustumCulled") {
          return;
        }

        if (
          node.right.type !== AST_NODE_TYPES.Literal ||
          node.right.value !== false
        ) {
          return;
        }

        const receiver = receiverKey(node.left.object);

        if (receiver === null) {
          return;
        }

        const objects = resolveBindingKeys(
          node,
          program,
          imports,
          isObject3DCtor
        );

        if (!objects.has(receiver)) {
          return;
        }

        context.report({
          node,
          messageId: "frustumCulledDisabled",
          data: { receiver },
        });
      },
    };
  },
});
