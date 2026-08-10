import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  isComponentDeclaration,
  isComponentFile,
  unwrapExport,
} from "../utils";

export const RULE_NAME = "one-component-per-file";

type MessageIds = "multi";

function declarationComponentIds(decl: TSESTree.Node): TSESTree.Identifier[] {
  const ids: TSESTree.Identifier[] = [];

  if (
    decl.type === AST_NODE_TYPES.FunctionDeclaration &&
    decl.id !== null &&
    /^[A-Z]/.test(decl.id.name)
  ) {
    ids.push(decl.id);
  } else if (decl.type === AST_NODE_TYPES.VariableDeclaration) {
    for (const d of decl.declarations) {
      if (
        d.id.type === AST_NODE_TYPES.Identifier &&
        /^[A-Z]/.test(d.id.name) &&
        (d.init?.type === AST_NODE_TYPES.ArrowFunctionExpression ||
          d.init?.type === AST_NODE_TYPES.FunctionExpression)
      ) {
        ids.push(d.id);
      }
    }
  }

  return ids;
}

export const oneComponentPerFileRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "One top-level React component per .tsx file — move extras to their own files",
    },
    schema: [],
    messages: {
      multi:
        "One component per file: '{{name}}' is a second component — move it to its own file.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!isComponentFile(context.filename)) {
      return {};
    }

    return {
      Program(program) {
        const components: TSESTree.Identifier[] = [];

        for (const statement of program.body) {
          const decl = unwrapExport(statement);

          if (!isComponentDeclaration(decl)) {
            continue;
          }

          components.push(...declarationComponentIds(decl));
        }

        for (const id of components.slice(1)) {
          context.report({
            node: id,
            messageId: "multi",
            data: { name: id.name },
          });
        }
      },
    };
  },
});
