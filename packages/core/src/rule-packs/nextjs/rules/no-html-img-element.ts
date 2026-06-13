import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-html-img-element";

type MessageIds = "useNextImage";

function isHtmlImgElement(name: TSESTree.JSXTagNameExpression): boolean {
  if (name.type === AST_NODE_TYPES.JSXIdentifier) {
    return name.name === "img";
  }

  return false;
}

export const noHtmlImgElementRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer next/image over raw <img> elements for optimized responsive images and Core Web Vitals.",
    },
    schema: [],
    messages: {
      useNextImage:
        "Use `next/image` `<Image />` instead of `<img>` — it optimizes formats, sizing, and LCP preload.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!context.filename.endsWith(".tsx")) {
      return {};
    }

    return {
      JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
        if (isHtmlImgElement(node.name)) {
          context.report({ node, messageId: "useNextImage" });
        }
      },
    };
  },
});
