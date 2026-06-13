import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "dangerous-html-requires-sanitize";

type MessageIds = "missingSanitize";

const SANITIZE_IMPORTS = new Set([
  "dompurify",
  "isomorphic-dompurify",
  "sanitize-html",
]);

function fileImportsSanitizer(program: TSESTree.Program): boolean {
  for (const statement of program.body) {
    if (statement.type !== AST_NODE_TYPES.ImportDeclaration) {
      continue;
    }

    const source = statement.source.value;

    if (typeof source !== "string") {
      continue;
    }

    const base = source.split("/")[0];

    if (base !== undefined && SANITIZE_IMPORTS.has(base)) {
      return true;
    }

    for (const spec of statement.specifiers) {
      if (
        spec.type === AST_NODE_TYPES.ImportSpecifier &&
        spec.imported.type === AST_NODE_TYPES.Identifier &&
        spec.imported.name.toLowerCase().includes("sanitize")
      ) {
        return true;
      }
    }
  }

  return false;
}

export const dangerousHtmlRequiresSanitizeRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "dangerouslySetInnerHTML requires a sanitization library (DOMPurify or equivalent) imported in the same file.",
    },
    schema: [],
    messages: {
      missingSanitize:
        "`dangerouslySetInnerHTML` requires sanitizing HTML first — import DOMPurify (or isomorphic-dompurify) and pass sanitized markup.",
    },
  },
  defaultOptions: [],
  create(context) {
    let hasSanitizerImport = false;

    return {
      Program(program: TSESTree.Program) {
        hasSanitizerImport = fileImportsSanitizer(program);
      },
      JSXAttribute(node: TSESTree.JSXAttribute) {
        if (
          node.name.type !== AST_NODE_TYPES.JSXIdentifier ||
          node.name.name !== "dangerouslySetInnerHTML"
        ) {
          return;
        }

        if (!hasSanitizerImport) {
          context.report({ node, messageId: "missingSanitize" });
        }
      },
    };
  },
});
