import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { analyzeThreeImports, memberPropertyName } from "../utils";

export const RULE_NAME = "no-unbounded-device-pixel-ratio";

export interface INoUnboundedDevicePixelRatioOptions {
  readonly maxPixelRatio?: number;
}

type RuleOptions = [INoUnboundedDevicePixelRatioOptions];
type MessageIds = "unboundedPixelRatio";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    maxPixelRatio: { type: "number", minimum: 0.5 },
  },
};

export const noUnboundedDevicePixelRatioRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Do not pass unbounded `window.devicePixelRatio` to `setPixelRatio`. Cap it so high-DPI displays cannot explode GPU memory.",
    },
    fixable: "code",
    schema: [optionSchema],
    messages: {
      unboundedPixelRatio:
        "Cap the device pixel ratio: `setPixelRatio(Math.min(window.devicePixelRatio, {{max}}))`. Unbounded DPR is a project performance policy, not a Three.js default.",
    },
  },
  defaultOptions: [{ maxPixelRatio: 2 }],
  create(context, [options]) {
    const maxPixelRatio = options.maxPixelRatio ?? 2;
    let imports = analyzeThreeImports(context.sourceCode.ast);

    return {
      Program(program) {
        imports = analyzeThreeImports(program);
      },
      CallExpression(node) {
        if (!imports.hasThreeImport) {
          return;
        }

        if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        if (memberPropertyName(node.callee) !== "setPixelRatio") {
          return;
        }

        const arg = node.arguments[0];

        if (!arg || !isWindowDevicePixelRatio(arg)) {
          return;
        }

        context.report({
          node: arg,
          messageId: "unboundedPixelRatio",
          data: { max: String(maxPixelRatio) },
          fix: (fixer) =>
            fixer.replaceText(
              arg,
              `Math.min(window.devicePixelRatio, ${String(maxPixelRatio)})`
            ),
        });
      },
    };
  },
});

function isWindowDevicePixelRatio(
  node: TSESTree.CallExpressionArgument
): boolean {
  if (node.type !== AST_NODE_TYPES.MemberExpression || node.computed) {
    return false;
  }

  if (
    node.object.type !== AST_NODE_TYPES.Identifier ||
    node.object.name !== "window"
  ) {
    return false;
  }

  return (
    node.property.type === AST_NODE_TYPES.Identifier &&
    node.property.name === "devicePixelRatio"
  );
}
