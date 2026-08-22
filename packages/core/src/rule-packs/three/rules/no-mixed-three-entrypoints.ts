import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  isLegacyExamplesJsmSource,
  isThreeCdnSource,
  isThreeSrcSource,
  requireSource,
  rewriteExamplesJsmToAddons,
} from "../utils";

export const RULE_NAME = "no-mixed-three-entrypoints";

type MessageIds = "legacyExamplesJsm" | "srcEntrypoint" | "cdnEntrypoint";

export const noMixedThreeEntrypointsRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Import Three.js only from `three` and `three/addons/...`. The legacy `three/examples/jsm/` path, `three/src/`, and CDN URLs create duplicate library instances.",
    },
    fixable: "code",
    schema: [],
    messages: {
      legacyExamplesJsm:
        "Import from `three/addons/...` instead of `three/examples/jsm/...` — mixing entrypoints can duplicate the Three.js runtime.",
      srcEntrypoint:
        "Do not import from `three/src/` or `three/build/` — use the `three` package entry and `three/addons/...`.",
      cdnEntrypoint:
        "Do not import Three.js from a CDN URL — install `three` and import from the package so every module shares one copy.",
    },
  },
  defaultOptions: [],
  create(context) {
    function reportSource(node: TSESTree.Node, source: string): void {
      if (isLegacyExamplesJsmSource(source)) {
        const next = rewriteExamplesJsmToAddons(source);

        context.report({
          node,
          messageId: "legacyExamplesJsm",
          fix:
            next === null
              ? undefined
              : (fixer) => fixer.replaceText(node, JSON.stringify(next)),
        });

        return;
      }

      if (isThreeSrcSource(source)) {
        context.report({ node, messageId: "srcEntrypoint" });

        return;
      }

      if (isThreeCdnSource(source)) {
        context.report({ node, messageId: "cdnEntrypoint" });
      }
    }

    return {
      ImportDeclaration(node) {
        if (typeof node.source.value === "string") {
          reportSource(node.source, node.source.value);
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source && typeof node.source.value === "string") {
          reportSource(node.source, node.source.value);
        }
      },
      ExportAllDeclaration(node) {
        if (typeof node.source.value === "string") {
          reportSource(node.source, node.source.value);
        }
      },
      ImportExpression(node) {
        if (
          node.source.type === AST_NODE_TYPES.Literal &&
          typeof node.source.value === "string"
        ) {
          reportSource(node.source, node.source.value);
        }
      },
      CallExpression(node) {
        const source = requireSource(node);
        const arg = node.arguments[0];

        if (source !== null && arg !== undefined) {
          reportSource(arg, source);
        }
      },
    };
  },
});
