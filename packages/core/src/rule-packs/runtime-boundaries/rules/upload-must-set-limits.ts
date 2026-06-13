import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "upload-must-set-limits";

type MessageIds = "missingUploadLimits";

const MULTIPART_CALLEE_NAMES = new Set(["file", "files", "saveRequestFiles"]);
const LIMIT_PROPERTY_NAMES = new Set(["limits", "maxFileSize"]);

function calleeEndsWithMultipartHandler(callee: TSESTree.Expression): boolean {
  if (callee.type === AST_NODE_TYPES.Identifier && callee.name === "multer") {
    return true;
  }

  if (callee.type !== AST_NODE_TYPES.MemberExpression) {
    return false;
  }

  if (callee.computed || callee.property.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }

  return MULTIPART_CALLEE_NAMES.has(callee.property.name);
}

function objectHasLimitProperty(node: TSESTree.ObjectExpression): boolean {
  return node.properties.some((prop) => {
    if (prop.type !== AST_NODE_TYPES.Property || prop.computed) {
      return false;
    }

    const key = prop.key;

    if (key.type === AST_NODE_TYPES.Identifier) {
      return LIMIT_PROPERTY_NAMES.has(key.name);
    }

    return (
      key.type === AST_NODE_TYPES.Literal &&
      typeof key.value === "string" &&
      LIMIT_PROPERTY_NAMES.has(key.value)
    );
  });
}

function nodeReferencesLimitName(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.Identifier) {
    return LIMIT_PROPERTY_NAMES.has(node.name);
  }

  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === "string") {
    return (
      node.value.includes("multipart") ||
      node.value.includes("@fastify/multipart")
    );
  }

  if (node.type === AST_NODE_TYPES.ImportDeclaration) {
    return node.source.value === "@fastify/multipart";
  }

  if (node.type === AST_NODE_TYPES.ObjectExpression) {
    return objectHasLimitProperty(node);
  }

  return false;
}

export const uploadMustSetLimitsRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Multipart upload handlers should declare `limits` or `maxFileSize` to bound request size.",
    },
    schema: [],
    messages: {
      missingUploadLimits:
        "Multipart upload handler is missing `limits` or `maxFileSize` configuration.",
    },
  },
  defaultOptions: [],
  create(context) {
    let handlesMultipart = false;
    let hasLimits = false;

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (nodeReferencesLimitName(node)) {
          handlesMultipart = true;
        }
      },
      Literal(node: TSESTree.Literal) {
        if (nodeReferencesLimitName(node)) {
          handlesMultipart = true;
        }
      },
      CallExpression(node: TSESTree.CallExpression) {
        if (calleeEndsWithMultipartHandler(node.callee)) {
          handlesMultipart = true;
        }
      },
      ObjectExpression(node: TSESTree.ObjectExpression) {
        if (objectHasLimitProperty(node)) {
          hasLimits = true;
        }
      },
      Identifier(node: TSESTree.Identifier) {
        if (LIMIT_PROPERTY_NAMES.has(node.name)) {
          hasLimits = true;
        }
      },
      "Program:exit"() {
        if (handlesMultipart && !hasLimits) {
          context.report({
            loc: { line: 1, column: 0 },
            messageId: "missingUploadLimits",
          });
        }
      },
    };
  },
});
