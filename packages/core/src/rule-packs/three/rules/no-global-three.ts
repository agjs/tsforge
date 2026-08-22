import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { analyzeThreeImports, requireSource } from "../utils";

export const RULE_NAME = "no-global-three";

type MessageIds = "globalThree" | "requireThree";

export const noGlobalThreeRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Do not rely on a global `THREE` identifier or `require('three')`. Import from the `three` package so the runtime is one module graph.",
    },
    schema: [],
    messages: {
      globalThree:
        "`THREE` is not imported in this file. Import from `three` instead of a script-tag global.",
      requireThree:
        'Use `import { ... } from "three"` instead of `require("three")`.',
    },
  },
  defaultOptions: [],
  create(context) {
    let imports = analyzeThreeImports(context.sourceCode.ast);

    return {
      Program(program) {
        imports = analyzeThreeImports(program);
      },
      Identifier(node) {
        if (node.name !== "THREE") {
          return;
        }

        if (isImportedThreeBinding(node, imports)) {
          return;
        }

        if (isNonValueReference(node)) {
          return;
        }

        context.report({ node, messageId: "globalThree" });
      },
      CallExpression(node) {
        const source = requireSource(node);

        if (source === "three" || source?.startsWith("three/")) {
          context.report({ node, messageId: "requireThree" });
        }
      },
    };
  },
});

function isImportedThreeBinding(
  node: TSESTree.Identifier,
  imports: ReturnType<typeof analyzeThreeImports>
): boolean {
  return (
    imports.namespaceNames.has(node.name) ||
    imports.namedBindings.has(node.name)
  );
}

function isNonValueReference(node: TSESTree.Identifier): boolean {
  const parent = node.parent;

  if (
    parent.type === AST_NODE_TYPES.ImportSpecifier ||
    parent.type === AST_NODE_TYPES.ImportDefaultSpecifier ||
    parent.type === AST_NODE_TYPES.ImportNamespaceSpecifier ||
    parent.type === AST_NODE_TYPES.ExportSpecifier
  ) {
    return true;
  }

  if (
    parent.type === AST_NODE_TYPES.MemberExpression &&
    parent.property === node
  ) {
    return true;
  }

  if (parent.type === AST_NODE_TYPES.TSQualifiedName && parent.right === node) {
    return true;
  }

  if (parent.type === AST_NODE_TYPES.VariableDeclarator && parent.id === node) {
    return true;
  }

  if (
    parent.type === AST_NODE_TYPES.FunctionDeclaration &&
    parent.id === node
  ) {
    return true;
  }

  if (parent.type === AST_NODE_TYPES.ClassDeclaration && parent.id === node) {
    return true;
  }

  return false;
}
