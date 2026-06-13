import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

export function isExpression(node: TSESTree.Node): node is TSESTree.Expression {
  return node.type !== AST_NODE_TYPES.SpreadElement;
}

export function isStringLiteral(node: TSESTree.Expression): boolean {
  return node.type === AST_NODE_TYPES.Literal && typeof node.value === "string";
}

export function isIdentifierNamed(node: TSESTree.Node, name: string): boolean {
  return node.type === AST_NODE_TYPES.Identifier && node.name === name;
}
