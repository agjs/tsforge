import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-react-fc";

type MessageIds = "noReactFc";

function isReactFcType(node: TSESTree.TSTypeReference): boolean {
  const typeName = node.typeName;

  if (typeName.type === AST_NODE_TYPES.TSQualifiedName) {
    const left = typeName.left;
    const right = typeName.right.name;

    if (left.type === AST_NODE_TYPES.Identifier && left.name === "React") {
      return right === "FC" || right === "FunctionComponent";
    }
  }

  if (typeName.type === AST_NODE_TYPES.Identifier) {
    return (
      typeName.name === "FC" ||
      typeName.name === "FunctionComponent" ||
      typeName.name === "VFC" ||
      typeName.name === "VoidFunctionComponent"
    );
  }

  return false;
}

export const noReactFcRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow React.FC / FunctionComponent — type props explicitly on the function parameter instead.",
    },
    schema: [],
    messages: {
      noReactFc:
        "Do not use `React.FC` or `FunctionComponent` — declare props explicitly on the function (e.g. `function Button({ onClick }: IButtonProps)`).",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      TSTypeReference(node: TSESTree.TSTypeReference) {
        if (isReactFcType(node)) {
          context.report({ node, messageId: "noReactFc" });
        }
      },
    };
  },
});
