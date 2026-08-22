import {
  AST_NODE_TYPES,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  analyzeNamespaceImport,
  hasAdditionalThreeValueImport,
  programDeclaresName,
  walkAll,
} from "../utils";

export const RULE_NAME = "prefer-named-three-imports";

type MessageIds = "preferNamedImports";

export const preferNamedThreeImportsRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer named imports from `three` over `import * as THREE`. Named imports make dependencies visible and tree-shakeable.",
    },
    fixable: "code",
    schema: [],
    messages: {
      preferNamedImports:
        "Import named bindings from `three` instead of `import * as {{name}}`. Rewrite only when every use is a static member.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "three") {
          return;
        }

        const namespace = namespaceSpecifier(node);

        if (!namespace) {
          return;
        }

        const program = context.sourceCode.ast;
        const usage = analyzeNamespaceImport(
          program,
          node,
          namespace.local.name
        );
        const canFix = canRewriteNamespace(program, node, usage);

        context.report({
          node,
          messageId: "preferNamedImports",
          data: { name: namespace.local.name },
          fix: canFix
            ? (fixer) => {
                const members = [...usage.members].sort();
                const named = members.join(", ");
                const importText = `import { ${named} } from "three";`;

                return [
                  fixer.replaceText(node, importText),
                  ...rewriteNamespaceMembers(
                    program,
                    usage.localName,
                    context.sourceCode,
                    fixer
                  ),
                ];
              }
            : undefined,
        });
      },
    };
  },
});

function namespaceSpecifier(
  node: TSESTree.ImportDeclaration
): TSESTree.ImportNamespaceSpecifier | TSESTree.ImportDefaultSpecifier | null {
  const spec = node.specifiers[0];

  if (!spec) {
    return null;
  }

  if (
    spec.type === AST_NODE_TYPES.ImportNamespaceSpecifier ||
    spec.type === AST_NODE_TYPES.ImportDefaultSpecifier
  ) {
    return spec;
  }

  return null;
}

function canRewriteNamespace(
  program: TSESTree.Program,
  importNode: TSESTree.ImportDeclaration,
  usage: ReturnType<typeof analyzeNamespaceImport>
): boolean {
  if (usage.escaped || usage.members.size === 0) {
    return false;
  }

  if (hasAdditionalThreeValueImport(program, importNode)) {
    return false;
  }

  for (const member of usage.members) {
    if (programDeclaresName(program, member)) {
      return false;
    }
  }

  return true;
}

function rewriteNamespaceMembers(
  program: TSESTree.Program,
  localName: string,
  sourceCode: { getText(node: TSESTree.Node): string },
  fixer: TSESLint.RuleFixer
): TSESLint.RuleFix[] {
  const fixes: TSESLint.RuleFix[] = [];

  walkAll(program, (node) => {
    if (node.type !== AST_NODE_TYPES.MemberExpression) {
      return;
    }

    if (node.computed) {
      return;
    }

    if (
      node.object.type !== AST_NODE_TYPES.Identifier ||
      node.object.name !== localName
    ) {
      return;
    }

    if (node.property.type !== AST_NODE_TYPES.Identifier) {
      return;
    }

    fixes.push(fixer.replaceText(node, sourceCode.getText(node.property)));
  });

  return fixes;
}
